// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ISP1BlockVerifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

interface IERC20Min {
    function balanceOf(address who) external view returns (uint256);
}

/// @notice Lands Tacit blocks on Ethereum and holds the ETH and tokens their notes are worth.
///
///         A block is one SP1 proof of the block program (contracts/sp1/confidential/tacit-block): it checks every
///         client spend proof in the block and moves the chain's state from the digest this contract holds to the
///         next. A block lands only on top of that digest, so there is one history. The sequencer alone may land
///         for `WINDOW` seconds after each landing, so what it has confirmed lands as confirmed; after that anyone
///         with a valid block may, so no one can hold the chain still.
///
///         A block's calldata carries everything it publishes: new notes (leaf and memo, sorted by leaf),
///         nullifiers, anchors older than the block program's recent roots, the deposits it took in and the exits
///         it pays, each list checked against the hash the proof commits. No list says which spend an entry came
///         from, and no spend's body is published.
///
///         `deposit` takes value and records (asset, value, commitment, body); a block's deposit record consumes
///         it, so the shield that spends it can only be the one the depositor's body named. Exits are credited to
///         their address and withdrawn with `withdraw`, so landing never calls out to a token or a recipient.
contract TacitBlocks {
    /// The BN254 scalar field's modulus: asset fields and every committed field element are below it.
    uint256 internal constant R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
    bytes internal constant ASSET_TAG = "tacit-btc-pool-zk-asset-v1";
    bytes internal constant LIST_DOMAIN = "tacit-block-list-v1";
    bytes internal constant MEMO_DOMAIN = "tacit-block-memo-v1";
    uint256 internal constant PUBLIC_WORDS = 12;
    uint256 internal constant DEPOSIT_LEN = 160;
    uint256 internal constant EXIT_LEN = 96;

    ISP1BlockVerifier public immutable VERIFIER;
    /// @notice The block program's verifying key.
    bytes32 public immutable BLOCK_VKEY;
    /// @notice The spend relation the block program takes, as it commits it (its key's digest, hashed).
    bytes32 public immutable SPEND_VK;
    address public immutable SEQUENCER;
    uint256 public immutable WINDOW;

    /// @notice The digest of the state the next block must start from, the note root it holds, how many blocks
    ///         have landed and when the last did.
    bytes32 public state;
    bytes32 public noteRoot;
    uint256 public height;
    uint256 public lastLanded;

    /// @notice Every note root a block has ended at (and the genesis root): what an anchor older than the block
    ///         program's recent roots must be.
    mapping(bytes32 => bool) public knownRoot;
    /// @notice Deposits not yet taken in, by keccak256(asset, value, cx, cy, body).
    mapping(bytes32 => uint256) public pendingDeposits;
    /// @notice The token an asset field stands for (the zero address for ETH), once something of it is deposited.
    mapping(bytes32 => address) public tokenOf;
    mapping(bytes32 => bool) public assetKnown;
    /// @notice Exits credited and not yet withdrawn, by token and recipient.
    mapping(address => mapping(address => uint256)) public owed;

    uint256 private unlocked = 1;

    event Deposited(address indexed token, uint256 value, bytes32 cx, bytes32 cy, bytes32 body, address indexed from);
    event Landed(uint256 indexed height, bytes32 state, bytes32 noteRoot, uint256 spends, address indexed by);
    event Withdrawn(address indexed token, address indexed to, uint256 value);

    error Reentered();
    error BadValue();
    error TransferFailed();
    error SequencerWindow();
    error BadPublicValues();
    error NotOnTop();
    error WrongRelation();
    error BadList(uint8 list);
    error BadMemo(uint256 output);
    error UnknownAnchor(bytes32 anchor);
    error NoSuchDeposit(uint256 deposit);
    error UnknownAsset(bytes32 asset);
    error BadAddress(uint256 exit);

    /// @notice The lists a block publishes, in the block program's committed order (`BlockData`): outputs as
    ///         leaf ‖ memo hash, 64 bytes each, with the memos themselves in the same order; deposits as
    ///         asset ‖ value ‖ cx ‖ cy ‖ body, 160 bytes each; exits as asset ‖ value ‖ address, 96 bytes each.
    struct Lists {
        bytes outputs;
        bytes[] memos;
        bytes32[] nullifiers;
        bytes32[] anchors;
        bytes deposits;
        bytes exits;
    }

    modifier nonReentrant() {
        if (unlocked != 1) revert Reentered();
        unlocked = 2;
        _;
        unlocked = 1;
    }

    /// @param genesisState The digest of the block program's genesis state for this chain (State::genesis with
    ///        the binding its spends carry), and `genesisRoot` its empty note tree's root.
    constructor(
        ISP1BlockVerifier verifier,
        bytes32 blockVkey,
        bytes32 spendVk,
        address sequencer,
        uint256 window,
        bytes32 genesisState,
        bytes32 genesisRoot
    ) {
        VERIFIER = verifier;
        BLOCK_VKEY = blockVkey;
        SPEND_VK = spendVk;
        SEQUENCER = sequencer;
        WINDOW = window;
        state = genesisState;
        noteRoot = genesisRoot;
        knownRoot[genesisRoot] = true;
        lastLanded = block.timestamp;
    }

    /// @notice The asset field the spend relation uses for `token` (the zero address for ETH):
    ///         SHA-256(ASSET_TAG ‖ token left-padded to 32 bytes), reduced mod r.
    function assetOf(address token) public pure returns (bytes32) {
        return bytes32(uint256(sha256(abi.encodePacked(ASSET_TAG, bytes32(uint256(uint160(token)))))) % R);
    }

    /// @notice Deposits `value` of `token` (ETH as msg.value when `token` is zero) for the shield spend whose
    ///         deposit commitment is (cx, cy) and whose body hash is `body`: only that spend can take it in.
    function deposit(address token, uint256 value, bytes32 cx, bytes32 cy, bytes32 body) external payable nonReentrant {
        if (value == 0 || value > type(uint64).max) revert BadValue();
        if (token == address(0)) {
            if (msg.value != value) revert BadValue();
        } else {
            if (msg.value != 0) revert BadValue();
            uint256 before = IERC20Min(token).balanceOf(address(this));
            _call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), value));
            if (IERC20Min(token).balanceOf(address(this)) - before != value) revert BadValue();
        }
        bytes32 asset = assetOf(token);
        if (!assetKnown[asset]) {
            assetKnown[asset] = true;
            tokenOf[asset] = token;
        }
        pendingDeposits[keccak256(abi.encode(asset, value, cx, cy, body))] += 1;
        emit Deposited(token, value, cx, cy, body, msg.sender);
    }

    /// @notice Lands the next block: its proof, its 12 public words and the lists it publishes.
    function land(bytes calldata publicValues, bytes calldata proof, Lists calldata lists) external nonReentrant {
        if (msg.sender != SEQUENCER && block.timestamp < lastLanded + WINDOW) revert SequencerWindow();
        VERIFIER.verifyProof(BLOCK_VKEY, publicValues, proof);
        if (publicValues.length != 32 * PUBLIC_WORDS) revert BadPublicValues();
        bytes32[12] memory w = abi.decode(publicValues, (bytes32[12]));
        if (w[0] != state) revert NotOnTop();
        if (w[11] != SPEND_VK) revert WrongRelation();

        uint256 outputs = uint256(w[5]);
        if (lists.outputs.length != 64 * outputs || lists.memos.length != outputs) revert BadList(1);
        if (_listHash(1, outputs, lists.outputs) != w[6]) revert BadList(1);
        for (uint256 i; i < outputs; ++i) {
            if (sha256(abi.encodePacked(MEMO_DOMAIN, lists.memos[i])) != bytes32(lists.outputs[64 * i + 32:64 * i + 64])) {
                revert BadMemo(i);
            }
        }
        if (_listHash(2, lists.nullifiers.length, abi.encodePacked(lists.nullifiers)) != w[7]) revert BadList(2);
        if (_listHash(3, lists.anchors.length, abi.encodePacked(lists.anchors)) != w[8]) revert BadList(3);
        for (uint256 i; i < lists.anchors.length; ++i) {
            if (!knownRoot[lists.anchors[i]]) revert UnknownAnchor(lists.anchors[i]);
        }

        bytes calldata deposits = lists.deposits;
        if (deposits.length % DEPOSIT_LEN != 0) revert BadList(4);
        uint256 nDeposits = deposits.length / DEPOSIT_LEN;
        if (_listHash(4, nDeposits, deposits) != w[9]) revert BadList(4);
        for (uint256 i; i < nDeposits; ++i) {
            bytes32 key = keccak256(deposits[DEPOSIT_LEN * i:DEPOSIT_LEN * (i + 1)]);
            if (pendingDeposits[key] == 0) revert NoSuchDeposit(i);
            pendingDeposits[key] -= 1;
        }

        bytes calldata exits = lists.exits;
        if (exits.length % EXIT_LEN != 0) revert BadList(5);
        uint256 nExits = exits.length / EXIT_LEN;
        if (_listHash(5, nExits, exits) != w[10]) revert BadList(5);
        for (uint256 i; i < nExits; ++i) {
            bytes32 asset = bytes32(exits[EXIT_LEN * i:EXIT_LEN * i + 32]);
            if (!assetKnown[asset]) revert UnknownAsset(asset);
            uint256 to = uint256(bytes32(exits[EXIT_LEN * i + 64:EXIT_LEN * (i + 1)]));
            if (to >> 160 != 0 || to == 0) revert BadAddress(i);
            owed[tokenOf[asset]][address(uint160(to))] += uint256(bytes32(exits[EXIT_LEN * i + 32:EXIT_LEN * i + 64]));
        }

        state = w[1];
        noteRoot = w[3];
        knownRoot[w[3]] = true;
        height += 1;
        lastLanded = block.timestamp;
        emit Landed(height, w[1], w[3], uint256(w[4]), msg.sender);
    }

    /// @notice Pays the caller what exits have credited them in `token` (the zero address for ETH).
    function withdraw(address token) external nonReentrant {
        uint256 value = owed[token][msg.sender];
        owed[token][msg.sender] = 0;
        if (token == address(0)) {
            (bool ok,) = msg.sender.call{value: value}("");
            if (!ok) revert TransferFailed();
        } else {
            _call(token, abi.encodeWithSelector(0xa9059cbb, msg.sender, value));
        }
        emit Withdrawn(token, msg.sender, value);
    }

    /// @dev SHA-256(LIST_DOMAIN ‖ tag ‖ count (u64 BE) ‖ items), the block program's `list_hash`.
    function _listHash(uint8 tag, uint256 count, bytes memory items) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(LIST_DOMAIN, tag, uint64(count), items));
    }

    /// @dev A token call that must succeed and return true or nothing.
    function _call(address token, bytes memory data) internal {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
