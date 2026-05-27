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
    function coversPool(bytes32 poolId) external view returns (bool);
    function ASSET_ID() external view returns (bytes32);
    function MIXER() external view returns (address);
}

/// @title TacitBridgeMixer
/// @notice Fully trustless ETH/ERC-20 ↔ Tacit bridge. No trusted roles.
///
///  Two operations:
///    deposit()          — lock funds, add leaf to Poseidon deposit tree
///    withdrawFromBurn() — relay-verify T_BRIDGE_BURN on Bitcoin, verify
///                         exact SP1-accepted burn claim + Groth16 proof,
///                         release funds
///
///  Security layers (each prevents a different attack class):
///    1. Bitcoin relay — proves burn tx is on canonical Bitcoin (heaviest chain)
///    2. SP1 state proof — proves pool root from complete Bitcoin blocks with
///       Groth16 verification of every envelope (no omissions, no fakes)
///    3. Accepted burn registry — only SP1-proven burns (exact claim ID bound
///       to nullifier + denom + poolRoot + recipient + bindHash) can trigger
///       withdrawals. Burns survive later state advancement.
///    4. Groth16 burn proof — proves the withdrawer knows a leaf's secrets
///    5. bindHash — domain-bound (chainid + address) to prevent replay
///    6. Pool balance — withdrawals cannot exceed deposited funds
///
///  Deposit roots are permanently stored in everKnownRoot and tracked via
///  rootAccumulator (running SHA256 hash). The SP1 verifier checks the
///  accumulator directly.
///
///  Decimal alignment: the constructor queries token decimals on-chain.
///  Tokens with >8 decimals require denominations aligned to UNIT_SCALE
///  so every amount maps to a whole Tacit unit (8 decimals).
///  Tokens with <=8 decimals need no alignment.
contract TacitBridgeMixer is ReentrancyGuardTransient {
    // ──────────────────── Constants ────────────────────

    uint256 public constant TREE_LEVELS = 20;
    uint256 public constant MAX_LEAVES = 1 << TREE_LEVELS;
    uint8 public constant TACIT_DECIMALS = 8;

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
    address public immutable TOKEN; // address(0) = native ETH, else ERC-20
    uint256 public immutable UNIT_SCALE; // 10^(tokenDecimals - 8), or 1 if ≤8
    bytes32 public immutable ASSET_ID;
    uint256 public immutable CONFIRMATION_DEPTH;
    uint8 public immutable NETWORK_TAG;

    // ──────────────────── Storage ────────────────────

    struct Pool {
        uint256 denomination;
        uint256 nextLeafIndex;
        uint256 balance;
        bytes32 currentRoot;
        mapping(uint256 => bytes32) filledSubtrees;
        mapping(bytes32 => bool) burnNullifiers;
        mapping(bytes32 => bool) commitments;
    }

    mapping(bytes32 => Pool) internal _pools;
    mapping(bytes32 => IPoolRootVerifier) public poolVerifiers;
    mapping(bytes32 => mapping(bytes32 => bool)) public everKnownRoot;
    mapping(bytes32 => bytes32) public rootAccumulator;
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
    error VerifierMismatch();

    // ──────────────────── Constructor ────────────────────

    constructor(
        address headerRelay_,
        address burnVerifier_,
        address token_,
        uint256 confirmationDepth_,
        uint256[] memory denominations_,
        address[] memory poolRootVerifiers_,
        uint8 networkTag_,
        bytes32 assetId_
    ) {
        if (headerRelay_ == address(0) || burnVerifier_ == address(0)) revert ZeroAddress();
        require(confirmationDepth_ > 0);
        require(denominations_.length == poolRootVerifiers_.length);

        HEADER_RELAY = BitcoinLightRelay(headerRelay_);
        BURN_VERIFIER = IGroth16Verifier(burnVerifier_);
        TOKEN = token_;
        CONFIRMATION_DEPTH = confirmationDepth_;
        NETWORK_TAG = networkTag_;
        ASSET_ID = assetId_;

        uint8 tokenDecimals = token_ == address(0) ? 18 : _queryDecimals(token_);
        UNIT_SCALE = tokenDecimals > TACIT_DECIMALS ? 10 ** (tokenDecimals - TACIT_DECIMALS) : 1;

        bytes32 z = bytes32(0);
        for (uint256 i; i < TREE_LEVELS; ++i) { zeros[i] = z; z = _hash(z, z); }

        for (uint256 i; i < denominations_.length; ++i) {
            if (denominations_[i] == 0 || denominations_[i] >= _FIELD_SIZE) revert DenominationNotAligned();
            if (UNIT_SCALE > 1 && denominations_[i] % UNIT_SCALE != 0) revert DenominationNotAligned();
            if (poolRootVerifiers_[i] == address(0)) revert ZeroAddress();
            bytes32 pid = keccak256(abi.encode(assetId_, denominations_[i]));
            if (_pools[pid].denomination != 0) revert DuplicateDenomination();
            IPoolRootVerifier vrf = IPoolRootVerifier(poolRootVerifiers_[i]);
            if (!vrf.coversPool(pid)) revert VerifierMismatch();
            if (vrf.ASSET_ID() != assetId_) revert VerifierMismatch();
            if (vrf.MIXER() != address(this)) revert VerifierMismatch();
            Pool storage p = _pools[pid];
            p.denomination = denominations_[i];
            for (uint256 j; j < TREE_LEVELS; ++j) p.filledSubtrees[j] = zeros[j];
            p.currentRoot = z;
            poolVerifiers[pid] = vrf;
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
            _safeTransferFromExact(TOKEN, msg.sender, totalValue);
        }
    }

    /// @notice Single deposit. For ETH: msg.value == denomination. For ERC-20: approve first.
    function deposit(bytes32 commitment, uint256 denomination) external payable nonReentrant {
        _insertDeposit(commitment, denomination);
        if (TOKEN == address(0)) {
            if (msg.value != denomination) revert InvalidDenomination();
        } else {
            if (msg.value != 0) revert InvalidDenomination();
            _safeTransferFromExact(TOKEN, msg.sender, denomination);
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
        everKnownRoot[pid][h] = true;
        rootAccumulator[pid] = sha256(abi.encodePacked(rootAccumulator[pid], h));
        p.nextLeafIndex++;
        p.balance += denomination;

        emit Deposit(pid, commitment, p.nextLeafIndex - 1, block.timestamp);
    }

    // ──────────────────── 2. Withdraw from Burn ────────────────────

    /// @notice Relay-verify T_BRIDGE_BURN, check exact SP1-accepted burn claim,
    ///         verify Groth16 proof, release funds.
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
        (bytes32 nullifierHash,, address payable recipient, bytes32 pid) = _validateBurn(env);

        Pool storage p = _pools[pid];
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
        internal view returns (bytes32 nullifierHash, bytes32 denomTacit, address payable recipient, bytes32 pid)
    {
        if (env.length < _BURN_ENVELOPE_MIN) revert InvalidBurnProof();
        if (uint8(env[0]) != _BURN_OPCODE) revert InvalidBurnProof();
        if (uint8(env[1]) != NETWORK_TAG) revert InvalidNetworkTag();
        if (_b32(env, _OFF_ASSET_ID) != ASSET_ID) revert InvalidAssetId();

        // Envelope denomination is in Tacit units (8-decimal). Map to wei for
        // pool lookup and balance accounting via UNIT_SCALE.
        denomTacit = _b32(env, _OFF_DENOM);
        nullifierHash = _b32(env, _OFF_NULLIFIER);
        recipient = _addr(env, _OFF_RECIPIENT);

        uint256 weiDenom = uint256(denomTacit) * UNIT_SCALE;
        pid = keccak256(abi.encode(ASSET_ID, weiDenom));
        Pool storage p = _pools[pid];
        if (p.denomination == 0 || p.denomination != weiDenom) revert InvalidDenomination();

        IPoolRootVerifier verifier = poolVerifiers[pid];
        if (address(verifier) == address(0)) revert ZeroAddress();

        bytes32 poolRoot = _b32(env, _OFF_MERKLE_ROOT);
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
                uint8(NETWORK_TAG), ASSET_ID, denomTacit, poolRoot,
                nullifierHash, rc, rLeaf, er, bn
            ))) % _FIELD_SIZE);
        }
        if (_b32(env, _OFF_BIND_HASH) != bindHash) revert InvalidBurnProof();

        // The exact burn claim ID binds nullifier + denomination + poolRoot + recipient + bindHash.
        // No current-root equality check needed — the claim itself proves the burn was valid
        // against a specific pool state that SP1 accepted. This allows withdrawals to succeed
        // even after later state transitions advance the pool root.
        bytes32 burnClaimId = sha256(abi.encodePacked(nullifierHash, denomTacit, poolRoot, recipient, bindHash));
        if (!verifier.isAcceptedBurn(burnClaimId)) revert UnprovenRoot();

        _verifyProof(env, poolRoot, nullifierHash, denomTacit, rLeaf, bindHash);
    }

    // ──────────────────── Views ────────────────────

    function getPoolRoot(bytes32 pid) external view returns (bytes32) { return _pools[pid].currentRoot; }
    function getPoolBalance(bytes32 pid) external view returns (uint256) { return _pools[pid].balance; }
    function isKnownDepositRoot(bytes32 pid, bytes32 root) external view returns (bool) { return everKnownRoot[pid][root]; }
    function isBurnNullifierSpent(bytes32 pid, bytes32 n) external view returns (bool) { return _pools[pid].burnNullifiers[n]; }
    function getPoolDenomination(bytes32 pid) external view returns (uint256) { return _pools[pid].denomination; }
    function getNextLeafIndex(bytes32 pid) external view returns (uint256) { return _pools[pid].nextLeafIndex; }
    function getRootAccumulator(bytes32 pid) external view returns (bytes32) { return rootAccumulator[pid]; }

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

    // ──────────────────── Internals: ERC-20 ────────────────────

    error TransferAmountMismatch();

    function _safeTransferFromExact(address token, address from, uint256 amount) internal {
        uint256 before = SafeTransferLib.balanceOf(token, address(this));
        SafeTransferLib.safeTransferFrom(token, from, address(this), amount);
        if (SafeTransferLib.balanceOf(token, address(this)) - before != amount) revert TransferAmountMismatch();
    }

    function _queryDecimals(address token) internal view returns (uint8) {
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSignature("decimals()"));
        require(ok && ret.length >= 32, "decimals() failed");
        return uint8(abi.decode(ret, (uint256)));
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
        if (tx_.length < 10) return new bytes(0);
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
        if (f == 0xfe) return uint32(uint8(d[p+1]))|(uint32(uint8(d[p+2]))<<8)|(uint32(uint8(d[p+3]))<<16)|(uint32(uint8(d[p+4]))<<24);
        return uint64(uint8(d[p+1]))|(uint64(uint8(d[p+2]))<<8)|(uint64(uint8(d[p+3]))<<16)|(uint64(uint8(d[p+4]))<<24)
              |(uint64(uint8(d[p+5]))<<32)|(uint64(uint8(d[p+6]))<<40)|(uint64(uint8(d[p+7]))<<48)|(uint64(uint8(d[p+8]))<<56);
    }
    function _viL(bytes calldata d, uint256 p) internal pure returns (uint256) {
        uint8 f = uint8(d[p]);
        if (f < 0xfd) return 1;
        if (f == 0xfd) return 3;
        if (f == 0xfe) return 5;
        return 9;
    }
    function _dsha(bytes memory d) internal pure returns (bytes32) { return sha256(abi.encodePacked(sha256(d))); }
}
