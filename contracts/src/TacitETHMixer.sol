// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoseidonT3} from "./lib/PoseidonT3.sol";
import {BitcoinLightRelay} from "./lib/BitcoinLightRelay.sol";
import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IGroth16Verifier {
    function verifyProof(
        uint256[2] calldata a, uint256[2][2] calldata b,
        uint256[2] calldata c, uint256[5] calldata input
    ) external view returns (bool);
}

interface IPoolRootVerifier {
    function isAcceptedBurn(bytes32 claimId) external view returns (bool);
    function currentState() external view returns (
        bytes32 poolRoot, bytes32 nullifierRoot, bytes32 depositRootsHash,
        uint64 stateHeight, bytes32 lastBlockHash
    );
}

/// @title TacitETHMixer
/// @notice Fully trustless ETH↔Tacit bridge with composable tETH.
///         No attestor, no guardian, no trusted roles.
///
///  Two operations:
///    deposit()          — lock ETH/ERC-20, add leaf to Poseidon deposit tree
///    withdrawFromBurn() — relay-verify T_BRIDGE_BURN on Bitcoin, verify
///                         the burn Groth16 proof against the CURRENT
///                         SP1-proven pool root, verify the burn was accepted
///                         by SP1 (exact claim ID check), release funds
///
///  Security layers (each prevents a different attack class):
///    1. Bitcoin relay — proves burn tx is on canonical Bitcoin (heaviest chain)
///    2. SP1 state proof — proves pool root from complete Bitcoin blocks with
///       Groth16 verification of every envelope (no omissions, no fakes)
///    3. Accepted burn registry — only SP1-proven burns (exact claim ID) can
///       trigger withdrawals (prevents rotation double-spend)
///    4. Groth16 burn proof — proves the withdrawer knows a leaf's secrets
///    5. bindHash — domain-bound (chainid + address) to prevent replay
///    6. Pool balance — withdrawals cannot exceed deposited funds
///
///  The pool root is proven via SP1: a ZK proof that the root is the correct
///  result of processing Bitcoin-canonical state transitions starting from
///  deposits in this contract. Anyone can generate and submit proofs.
///
///  V1 operational notes:
///    - The SP1 verifier requires lastBlockHash == relay tip. A relay tip
///      advance between proof generation and submission makes the proof stale.
///      The prover retries with updated headers. This ensures proofs reference
///      the same canonical history as the relay.
///    - Root history is 100 entries. A valid burn becomes unredeemable if
///      100+ deposits occur before the Ethereum withdrawal lands. Users should
///      withdraw promptly after burn confirmation.
///    - The deposit tree uses fixed denominations (0.01/0.1/1/10/100 ETH).
///      Each denomination has its own pool. Denomination is inside the Poseidon
///      leaf commitment and the Groth16 public inputs — cross-denomination
///      proofs fail at the circuit level.
contract TacitETHMixer is ReentrancyGuardTransient {
    // ──────────────────── Constants ────────────────────

    uint256 public constant ROOT_HISTORY_SIZE = 100;
    uint256 public constant TREE_LEVELS = 20;
    uint256 public constant MAX_LEAVES = 1 << TREE_LEVELS;
    uint256 public constant WEI_PER_TETH_UNIT = 1e10;

    uint256 internal constant _FIELD_SIZE =
        21888242871839275222246405745257275088548364400416034343698204186575808495617;

    uint256 internal constant _BURN_OPCODE = 0x61;
    uint256 internal constant _BURN_ENVELOPE_MIN = 281;
    uint256 internal constant _OFF_ASSET_ID      = 2;
    uint256 internal constant _OFF_DENOM         = 34;
    uint256 internal constant _OFF_MERKLE_ROOT   = 66;
    uint256 internal constant _OFF_NULLIFIER     = 98;
    uint256 internal constant _OFF_RECIP_COMMIT  = 130;
    uint256 internal constant _OFF_R_LEAF        = 163;
    uint256 internal constant _OFF_RECIPIENT     = 195;
    uint256 internal constant _OFF_BURN_NONCE    = 215;
    uint256 internal constant _OFF_BIND_HASH     = 247;
    uint256 internal constant _OFF_PROOF_LEN     = 279;
    uint256 internal constant _OFF_PROOF         = 281;
    uint256 internal constant _GROTH16_SIZE      = 256;

    // ──────────────────── Immutables ────────────────────

    BitcoinLightRelay public immutable HEADER_RELAY;
    IGroth16Verifier public immutable BURN_VERIFIER;
    IPoolRootVerifier public immutable POOL_ROOT_VERIFIER;
    address public immutable TOKEN; // address(0) = native ETH, else ERC-20
    bytes32 public immutable ASSET_ID;
    uint256 public immutable CONFIRMATION_DEPTH;
    uint8 public immutable NETWORK_TAG;

    // ──────────────────── Storage ────────────────────

    struct Pool {
        uint256 denomination;
        uint256 nextLeafIndex;
        uint256 balance;
        bytes32 currentRoot;
        uint256 currentRootIndex;
        bytes32[100] roots;
        mapping(uint256 => bytes32) filledSubtrees;
        mapping(bytes32 => bool) burnNullifiers;
        mapping(bytes32 => bool) commitments;
    }

    mapping(bytes32 => Pool) internal _pools;
    bytes32[] public poolIds;
    bytes32[TREE_LEVELS] public zeros;

    // ──────────────────── Events ────────────────────

    event Deposit(bytes32 indexed poolId, bytes32 indexed commitment, uint256 leafIndex, uint256 timestamp);
    event Withdrawal(bytes32 indexed poolId, bytes32 indexed nullifierHash, address recipient, uint256 amount);

    // ──────────────────── Errors ────────────────────

    error InvalidAssetId();
    error InvalidBurnProof();
    error MerkleTreeFull();
    error UnprovenRoot();
    error ZeroAddress();
    error DuplicateCommitment();
    error InvalidDenomination();
    error InvalidNetworkTag();
    error DuplicateDenomination();
    error InvalidFieldElement();
    error InvalidGroth16Proof();
    error NullifierAlreadySpent();
    error DenominationNotAligned();
    error InsufficientPoolBalance();

    // ──────────────────── Constructor ────────────────────

    constructor(
        address headerRelay_,
        address burnVerifier_,
        address poolRootVerifier_,
        address token_,
        uint256 confirmationDepth_,
        uint256[] memory denominations_,
        uint8 networkTag_,
        bytes32 assetId_
    ) {
        if (headerRelay_ == address(0) || burnVerifier_ == address(0) || poolRootVerifier_ == address(0)) {
            revert ZeroAddress();
        }
        require(confirmationDepth_ > 0);

        HEADER_RELAY = BitcoinLightRelay(headerRelay_);
        BURN_VERIFIER = IGroth16Verifier(burnVerifier_);
        POOL_ROOT_VERIFIER = IPoolRootVerifier(poolRootVerifier_);
        TOKEN = token_;
        CONFIRMATION_DEPTH = confirmationDepth_;
        NETWORK_TAG = networkTag_;
        ASSET_ID = assetId_;

        bytes32 z = bytes32(0);
        for (uint256 i; i < TREE_LEVELS; ++i) { zeros[i] = z; z = _hash(z, z); }

        for (uint256 i; i < denominations_.length; ++i) {
            if (denominations_[i] == 0) revert DenominationNotAligned();
            if (token_ == address(0) && denominations_[i] % WEI_PER_TETH_UNIT != 0) revert DenominationNotAligned();
            bytes32 pid = keccak256(abi.encode(assetId_, denominations_[i]));
            if (_pools[pid].denomination != 0) revert DuplicateDenomination();
            Pool storage p = _pools[pid];
            p.denomination = denominations_[i];
            for (uint256 j; j < TREE_LEVELS; ++j) p.filledSubtrees[j] = zeros[j];
            p.currentRoot = z;
            p.roots[0] = z;
            poolIds.push(pid);
        }
    }

    receive() external payable { revert InvalidDenomination(); }

    // ──────────────────── 1. Deposit ────────────────────

    /// @notice Batch deposit — split an amount into multiple denominations in one tx.
    ///         Each entry is a (commitment, denomination) pair. For ETH, msg.value
    ///         must equal the sum of all denominations.
    function batchDeposit(bytes32[] calldata commitments, uint256[] calldata denominations) external payable nonReentrant {
        require(commitments.length == denominations.length);
        uint256 totalValue;
        for (uint256 i; i < commitments.length; ++i) {
            _insertDeposit(commitments[i], denominations[i]);
            totalValue += denominations[i];
        }
        if (TOKEN == address(0)) {
            if (msg.value != totalValue) revert InvalidDenomination();
        } else {
            if (msg.value != 0) revert InvalidDenomination();
            SafeTransferLib.safeTransferFrom(TOKEN, msg.sender, address(this), totalValue);
        }
    }

    /// @notice Single deposit. For ETH: msg.value == denomination. For ERC-20: approve first.
    function deposit(bytes32 commitment, uint256 denomination) external payable nonReentrant {
        _insertDeposit(commitment, denomination);
        if (TOKEN == address(0)) {
            if (msg.value != denomination) revert InvalidDenomination();
        } else {
            if (msg.value != 0) revert InvalidDenomination();
            SafeTransferLib.safeTransferFrom(TOKEN, msg.sender, address(this), denomination);
        }
    }

    function _insertDeposit(bytes32 commitment, uint256 denomination) internal {
        bytes32 pid = keccak256(abi.encode(ASSET_ID, denomination));
        Pool storage p = _pools[pid];
        if (p.denomination == 0 || p.denomination != denomination) revert InvalidDenomination();
        if (p.nextLeafIndex >= MAX_LEAVES) revert MerkleTreeFull();
        if (uint256(commitment) >= _FIELD_SIZE) revert InvalidFieldElement();
        if (p.commitments[commitment]) revert DuplicateCommitment();

        p.commitments[commitment] = true;

        uint256 idx = p.nextLeafIndex;
        bytes32 h = commitment;
        for (uint256 i; i < TREE_LEVELS; ++i) {
            if (idx & 1 == 0) { p.filledSubtrees[i] = h; h = _hash(h, zeros[i]); }
            else { h = _hash(p.filledSubtrees[i], h); }
            idx >>= 1;
        }

        p.currentRoot = h;
        uint256 ri = (p.currentRootIndex + 1) % ROOT_HISTORY_SIZE;
        p.currentRootIndex = ri;
        p.roots[ri] = h;
        p.nextLeafIndex++;
        p.balance += denomination;

        emit Deposit(pid, commitment, p.nextLeafIndex - 1, block.timestamp);
    }



    // ──────────────────── 3. Withdraw from Burn ────────────────────

    /// @notice Relay-verify T_BRIDGE_BURN + Groth16 against SP1-proven pool root.
    function withdrawFromBurn(
        bytes calldata rawBtcTx,
        bytes calldata proofHeaders,
        uint256 burnBlockHeight,
        bytes32[] calldata txMerkleProof,
        uint256 txIndex
    ) external nonReentrant {
        {
            bytes32 txid = _computeTxid(rawBtcTx);
            bytes32 blockMR = HEADER_RELAY.verifyBlock(proofHeaders, burnBlockHeight, CONFIRMATION_DEPTH);
            if (!_verifyTxInclusion(txid, blockMR, txMerkleProof, txIndex)) revert InvalidBurnProof();
        }

        bytes memory env = _extractEnvByOpcode(rawBtcTx, _BURN_OPCODE, _BURN_ENVELOPE_MIN);
        (bytes32 nullifierHash, bytes32 denomWei, address payable recipient) = _validateBurn(env);

        bytes32 pid = keccak256(abi.encode(ASSET_ID, uint256(denomWei)));
        Pool storage p = _pools[pid];
        if (p.denomination == 0 || p.denomination != uint256(denomWei)) revert InvalidDenomination();
        if (p.burnNullifiers[nullifierHash]) revert NullifierAlreadySpent();
        if (recipient == address(0)) revert InvalidBurnProof();
        if (p.balance < p.denomination) revert InsufficientPoolBalance();

        p.burnNullifiers[nullifierHash] = true;
        p.balance -= p.denomination;
        emit Withdrawal(pid, nullifierHash, recipient, p.denomination);
        if (TOKEN == address(0)) {
            SafeTransferLib.forceSafeTransferETH(recipient, p.denomination);
        } else {
            SafeTransferLib.safeTransfer(TOKEN, recipient, p.denomination);
        }
    }

    function _validateBurn(bytes memory env)
        internal view returns (bytes32 nullifierHash, bytes32 denomWei, address payable recipient)
    {
        if (env.length < _BURN_ENVELOPE_MIN) revert InvalidBurnProof();
        if (uint8(env[0]) != _BURN_OPCODE) revert InvalidBurnProof();
        if (uint8(env[1]) != NETWORK_TAG) revert InvalidNetworkTag();
        if (_b32(env, _OFF_ASSET_ID) != ASSET_ID) revert InvalidAssetId();

        denomWei = _b32(env, _OFF_DENOM);
        nullifierHash = _b32(env, _OFF_NULLIFIER);
        recipient = _addr(env, _OFF_RECIPIENT);

        // Pool root must be the CURRENT SP1-proven state — not any historical root.
        // This prevents rotation double-spend: once a note is spent and the state
        // advances, proofs against the old root where the note existed are rejected.
        bytes32 poolRoot = _b32(env, _OFF_MERKLE_ROOT);
        bytes32 currentPoolRoot = _getCurrentProvenPoolRoot();
        if (poolRoot != currentPoolRoot) revert UnprovenRoot();

        bytes32 rLeaf = _b32(env, _OFF_R_LEAF);

        bytes32 bindHash;
        {
            bytes memory rc = new bytes(33);
            for (uint256 i; i < 33; ++i) rc[i] = env[_OFF_RECIP_COMMIT + i];
            bytes memory er = new bytes(20);
            for (uint256 i; i < 20; ++i) er[i] = env[_OFF_RECIPIENT + i];
            bytes32 bn = _b32(env, _OFF_BURN_NONCE);

            bindHash = bytes32(uint256(sha256(abi.encodePacked(
                "tacit-bridge-burn-v1", block.chainid, address(this),
                uint8(NETWORK_TAG), ASSET_ID, denomWei, poolRoot,
                nullifierHash, rc, rLeaf, er, bn
            ))) % _FIELD_SIZE);
        }
        if (_b32(env, _OFF_BIND_HASH) != bindHash) revert InvalidBurnProof();

        // Exact-burn binding: the SP1 state machine must have accepted this specific burn.
        bytes32 burnClaimId = sha256(abi.encodePacked(nullifierHash, denomWei, poolRoot, recipient, bindHash));
        if (!POOL_ROOT_VERIFIER.isAcceptedBurn(burnClaimId)) revert UnprovenRoot();

        _verifyProof(env, poolRoot, nullifierHash, denomWei, rLeaf, bindHash);
    }

    function _getCurrentProvenPoolRoot() internal view returns (bytes32 poolRoot) {
        (poolRoot,,,,) = POOL_ROOT_VERIFIER.currentState();
    }

    function _isKnownRoot(bytes32 pid, bytes32 root) internal view returns (bool) {
        if (root == bytes32(0)) return false;
        Pool storage p = _pools[pid];
        uint256 idx = p.currentRootIndex;
        for (uint256 i; i < ROOT_HISTORY_SIZE; ++i) {
            if (p.roots[idx] == root) return true;
            idx = idx == 0 ? ROOT_HISTORY_SIZE - 1 : idx - 1;
        }
        return false;
    }

    // ──────────────────── Views ────────────────────

    function getPoolRoot(bytes32 pid) external view returns (bytes32) { return _pools[pid].currentRoot; }
    function getPoolBalance(bytes32 pid) external view returns (uint256) { return _pools[pid].balance; }
    function isKnownDepositRoot(bytes32 pid, bytes32 root) external view returns (bool) { return _isKnownRoot(pid, root); }
    function isBurnNullifierSpent(bytes32 pid, bytes32 n) external view returns (bool) { return _pools[pid].burnNullifiers[n]; }
    function getPoolDenomination(bytes32 pid) external view returns (uint256) { return _pools[pid].denomination; }
    function getNextLeafIndex(bytes32 pid) external view returns (uint256) { return _pools[pid].nextLeafIndex; }

    // ──────────────────── Internals: Groth16 ────────────────────

    function _verifyProof(
        bytes memory env, bytes32 root, bytes32 nh, bytes32 den, bytes32 rl, bytes32 bh
    ) internal view {
        if (uint256(root) >= _FIELD_SIZE) revert InvalidFieldElement();
        if (uint256(nh) >= _FIELD_SIZE) revert InvalidFieldElement();
        if (uint256(den) >= _FIELD_SIZE) revert InvalidFieldElement();
        if (uint256(rl) >= _FIELD_SIZE) revert InvalidFieldElement();
        if (uint256(bh) >= _FIELD_SIZE) revert InvalidFieldElement();

        uint256 pl = uint16(uint8(env[_OFF_PROOF_LEN])) | (uint16(uint8(env[_OFF_PROOF_LEN+1])) << 8);
        if (pl != _GROTH16_SIZE) revert InvalidGroth16Proof();
        if (env.length < _OFF_PROOF + _GROTH16_SIZE) revert InvalidGroth16Proof();

        uint256 o = _OFF_PROOF;
        uint256[2] memory a; uint256[2][2] memory b; uint256[2] memory c;
        a[0]=_u(env,o); a[1]=_u(env,o+32);
        b[0][0]=_u(env,o+64); b[0][1]=_u(env,o+96);
        b[1][0]=_u(env,o+128); b[1][1]=_u(env,o+160);
        c[0]=_u(env,o+192); c[1]=_u(env,o+224);

        uint256[5] memory pub;
        pub[0]=uint256(root); pub[1]=uint256(nh);
        pub[2]=uint256(den); pub[3]=uint256(rl); pub[4]=uint256(bh);

        if (!BURN_VERIFIER.verifyProof(a, b, c, pub)) revert InvalidGroth16Proof();
    }

    // ──────────────────── Internals: Poseidon ────────────────────

    function _hash(bytes32 l, bytes32 r) internal pure returns (bytes32) {
        uint256[2] memory inp; inp[0]=uint256(l); inp[1]=uint256(r);
        return bytes32(PoseidonT3.hash(inp));
    }

    // ──────────────────── Internals: Bitcoin tx parsing ────────────────────

    function _computeTxid(bytes calldata tx_) internal pure returns (bytes32) {
        if (tx_.length < 10 || tx_[4] != 0x00 || tx_[5] != 0x01) return _dsha(tx_);
        uint256 pos = 6;
        uint256 cnt = _vi(tx_,pos); pos += _viL(tx_,pos);
        for (uint256 i; i < cnt; ++i) { pos += 36; uint256 s = _vi(tx_,pos); pos += _viL(tx_,pos)+s+4; }
        cnt = _vi(tx_,pos); pos += _viL(tx_,pos);
        for (uint256 i; i < cnt; ++i) { pos += 8; uint256 s = _vi(tx_,pos); pos += _viL(tx_,pos)+s; }
        return _dsha(abi.encodePacked(tx_[:4], tx_[6:pos], tx_[tx_.length-4:]));
    }

    function _extractEnvByOpcode(bytes calldata tx_, uint256 opcode, uint256 minLen) internal pure returns (bytes memory) {
        uint256 pos = 4;
        if (tx_[pos] == 0x00 && tx_[pos+1] == 0x01) pos += 2;
        uint256 cnt = _vi(tx_,pos); pos += _viL(tx_,pos);
        for (uint256 i; i < cnt; ++i) { pos += 36; uint256 s = _vi(tx_,pos); pos += _viL(tx_,pos)+s+4; }
        cnt = _vi(tx_,pos); pos += _viL(tx_,pos);
        for (uint256 i; i < cnt; ++i) {
            pos += 8; uint256 sl = _vi(tx_,pos); pos += _viL(tx_,pos); uint256 ss = pos;
            if (sl > 2 && uint8(tx_[ss]) == 0x6a) {
                uint256 ds = ss+1; uint8 op = uint8(tx_[ds]); uint256 dl;
                if (op == 0x4d) { dl = uint16(uint8(tx_[ds+1]))|(uint16(uint8(tx_[ds+2]))<<8); ds += 3; }
                else if (op == 0x4c) { dl = uint8(tx_[ds+1]); ds += 2; }
                else { dl = op; ds += 1; }
                if (dl >= minLen && ds+dl <= ss+sl && uint8(tx_[ds]) == opcode) {
                    bytes memory out = new bytes(dl);
                    for (uint256 j; j < dl; ++j) out[j] = tx_[ds+j];
                    return out;
                }
            }
            pos = ss + sl;
        }
        return new bytes(0);
    }

    function _verifyTxInclusion(bytes32 txid, bytes32 root, bytes32[] calldata proof, uint256 idx) internal pure returns (bool) {
        bytes32 cur = txid;
        for (uint256 i; i < proof.length; ++i) {
            cur = idx & 1 == 0 ? _dsha(abi.encodePacked(cur,proof[i])) : _dsha(abi.encodePacked(proof[i],cur));
            idx >>= 1;
        }
        return cur == root;
    }

    function _b32(bytes memory d, uint256 o) internal pure returns (bytes32 r) { assembly { r := mload(add(add(d,32),o)) } }
    function _u(bytes memory d, uint256 o) internal pure returns (uint256 r) { assembly { r := mload(add(add(d,32),o)) } }
    function _addr(bytes memory d, uint256 o) internal pure returns (address payable r) {
        uint256 v; for (uint256 i; i < 20; ++i) v = (v<<8)|uint8(d[o+i]); r = payable(address(uint160(v)));
    }
    function _vi(bytes calldata d, uint256 p) internal pure returns (uint256) {
        uint8 f = uint8(d[p]); if (f < 0xfd) return f;
        if (f == 0xfd) return uint16(uint8(d[p+1]))|(uint16(uint8(d[p+2]))<<8);
        revert InvalidBurnProof();
    }
    function _viL(bytes calldata d, uint256 p) internal pure returns (uint256) { return uint8(d[p]) < 0xfd ? 1 : 3; }
    function _dsha(bytes memory d) internal pure returns (bytes32) { return sha256(abi.encodePacked(sha256(d))); }
}
