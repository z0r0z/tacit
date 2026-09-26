// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

/// Groth16 verifier exported from dapp/circuits/evm-pool/transact.circom (snarkjs
/// `zkey export solidityverifier`). Public input order: root, oldRoot, newRoot, startIndex,
/// publicAmount, extDataHash, asset, nf[2], outLeaf[2].
interface ITransactVerifier {
    function verifyProof(uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC, uint256[11] calldata publicInputs)
        external
        view
        returns (bool);
}

/// A single-asset, client-proved shielded pool: fungible balances, private transfers with change, and
/// deposit/withdraw at the boundary, all in one Groth16 relation the user proves on their own device
/// (dapp/circuits/evm-pool/transact.circom, dapp/evm-pool-zk.js). See
/// contracts/sp1/confidential/DESIGN-evm-client-pool.md.
///
/// Immutable, matching V1 (SPEC §8): no owner, no pause, no admin function. If the relation or verifier
/// ever needs to change, a successor pool is deployed at a new address; this contract never rotates.
///
/// Notes live in an append-only Poseidon(2) tree of depth 32; each transact() call inserts exactly one
/// pair of leaves (an empty output slot is still a leaf, value 0) at the pool's current size, proven
/// in-circuit against `oldRoot`/`newRoot` — the contract never hashes. `root` is the pool's current head;
/// `everKnownRoot` retains every root the pool has ever held, so a prover can build a membership proof
/// against a root that is no longer current without racing the next writer.
contract TacitEvmPool {
    ITransactVerifier public immutable VERIFIER;
    address public immutable ASSET; // address(0) = native ETH
    uint256 internal immutable ASSET_FIELD; // keccak256(chainid, pool, ASSET) mod P, the circuit's `asset`

    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    int256 internal constant P_INT = int256(P);
    uint256 internal constant VALUE_MAX = 1 << 120; // circuit's valueBits

    bytes32 public root;
    uint256 public nextIndex; // even; the pool's leaf count
    mapping(bytes32 => bool) public everKnownRoot;
    mapping(bytes32 => bool) public nullified;

    event Transact(
        bytes32 indexed nf0,
        bytes32 indexed nf1,
        bytes32 outLeaf0,
        bytes32 outLeaf1,
        uint256 firstIndex,
        bytes32 newRoot,
        address recipient,
        int256 extAmount,
        address relayer,
        uint256 fee,
        bytes memo0,
        bytes memo1
    );

    error ZeroAddress();
    error NotAContract();
    error WrongAsset();
    error StaleRoot();
    error UnknownMembershipRoot();
    error WrongInsertionIndex();
    error PoolFull();
    error AlreadyNullified();
    error BadProof();
    error ValueOutOfRange();
    error EthValueMismatch();
    error EthNotAccepted();
    error FeeOnTransferAsset();

    constructor(address verifier_, address asset_) {
        if (verifier_ == address(0)) revert ZeroAddress();
        if (verifier_.code.length == 0) revert NotAContract();
        if (asset_ != address(0) && asset_.code.length == 0) revert NotAContract();
        VERIFIER = ITransactVerifier(verifier_);
        ASSET = asset_;
        ASSET_FIELD = uint256(keccak256(abi.encode(block.chainid, address(this), asset_))) % P;
        // Poseidon(0, 0), depth 32: the root of an all-empty tree.
        root = bytes32(uint256(21443572485391568159800782191812935835534334817699172242223315142338162256601));
        everKnownRoot[root] = true;
    }

    /// One relation for deposit, private transfer and withdraw: `extAmount > 0` pulls that much ASSET
    /// from msg.sender into the pool; `extAmount < 0` pays `-extAmount` to `recipient`; `extAmount == 0`
    /// is a pure in-pool transfer. `fee`, if non-zero, is paid to `relayer` out of the pool's custody in
    /// the same call, independent of `extAmount`'s sign — the same call can deposit/withdraw and pay a
    /// relayer at once. `recipient`, `extAmount`, `relayer`, `fee` and both memos are bound into the
    /// proof's `extDataHash` (recomputed here, not trusted from the caller), so they cannot be changed
    /// after the owner signed the spend.
    function transact(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[11] calldata publicInputs,
        address recipient,
        int256 extAmount,
        address relayer,
        uint256 fee,
        bytes calldata memo0,
        bytes calldata memo1
    ) external payable {
        if (publicInputs[6] != ASSET_FIELD) revert WrongAsset();
        if (bytes32(publicInputs[1]) != root) revert StaleRoot();
        if (!everKnownRoot[bytes32(publicInputs[0])]) revert UnknownMembershipRoot();
        if (publicInputs[3] != nextIndex) revert WrongInsertionIndex();
        if (nextIndex + 2 > (1 << 32)) revert PoolFull();
        if (extAmount <= -int256(VALUE_MAX) || extAmount >= int256(VALUE_MAX)) revert ValueOutOfRange();
        if (fee >= VALUE_MAX) revert ValueOutOfRange();

        bytes32 nf0 = bytes32(publicInputs[7]);
        bytes32 nf1 = bytes32(publicInputs[8]);
        if (nf0 != bytes32(0) && nullified[nf0]) revert AlreadyNullified();
        if (nf1 != bytes32(0) && nf1 == nf0) revert AlreadyNullified();
        if (nf1 != bytes32(0) && nullified[nf1]) revert AlreadyNullified();

        uint256 wantExtHash = uint256(
            keccak256(abi.encode(block.chainid, address(this), recipient, extAmount, relayer, fee, keccak256(memo0), keccak256(memo1)))
        ) % P;
        if (publicInputs[5] != wantExtHash) revert BadProof();
        if (publicInputs[4] != _publicAmount(extAmount, fee)) revert BadProof();

        if (!VERIFIER.verifyProof(pA, pB, pC, publicInputs)) revert BadProof();

        if (nf0 != bytes32(0)) nullified[nf0] = true;
        if (nf1 != bytes32(0)) nullified[nf1] = true;
        bytes32 newRoot = bytes32(publicInputs[2]);
        root = newRoot;
        everKnownRoot[newRoot] = true;
        uint256 firstIndex = nextIndex;
        nextIndex = firstIndex + 2;

        _settle(recipient, extAmount, relayer, fee);

        emit Transact(
            nf0, nf1, bytes32(publicInputs[9]), bytes32(publicInputs[10]), firstIndex, newRoot,
            recipient, extAmount, relayer, fee, memo0, memo1
        );
    }

    function _publicAmount(int256 extAmount, uint256 fee) internal pure returns (uint256) {
        int256 pa = (extAmount - int256(fee)) % P_INT;
        if (pa < 0) pa += P_INT;
        return uint256(pa);
    }

    function _settle(address recipient, int256 extAmount, address relayer, uint256 fee) internal {
        if (ASSET == address(0)) {
            uint256 inflow = extAmount > 0 ? uint256(extAmount) : 0;
            if (msg.value != inflow) revert EthValueMismatch();
            if (extAmount < 0) SafeTransferLib.forceSafeTransferETH(recipient, uint256(-extAmount));
            if (fee != 0) SafeTransferLib.forceSafeTransferETH(relayer, fee);
        } else {
            if (msg.value != 0) revert EthNotAccepted();
            if (extAmount > 0) {
                uint256 amount = uint256(extAmount);
                uint256 before = SafeTransferLib.balanceOf(ASSET, address(this));
                SafeTransferLib.safeTransferFrom(ASSET, msg.sender, address(this), amount);
                if (SafeTransferLib.balanceOf(ASSET, address(this)) - before != amount) revert FeeOnTransferAsset();
            } else if (extAmount < 0) {
                SafeTransferLib.safeTransfer(ASSET, recipient, uint256(-extAmount));
            }
            if (fee != 0) SafeTransferLib.safeTransfer(ASSET, relayer, fee);
        }
    }
}
