// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ISP1BlockVerifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

interface IERC20Min {
    function balanceOf(address who) external view returns (uint256);
}

/// Whose turn it is to land (TacitSeats: TAC stakers by turns). `turn` may keep what it needs to say so (an epoch's seed); zero means no
/// one leads now.
interface ITurns {
    function turn() external returns (address);
}

/// @notice Lands Tacit blocks on Ethereum and holds the ETH and tokens their notes are worth.
///
///         A block is one SP1 proof of the block program (contracts/sp1/confidential/tacit-block): it checks every
///         client spend proof in the block and moves the chain's state from the digest this contract holds to the
///         next. A block lands only on top of that digest, so there is one history. Until the chain has gone
///         `WINDOW` seconds without a block, only the leader of the current turn (`TURNS`, TAC stakers in turn) may
///         land, so what it has confirmed lands as confirmed and no one else's proof of the same height is wasted;
///         after that, or in a turn no one leads, anyone with a valid block may.
///
///         A block proven against the state lands only if nothing it relies on has changed meanwhile, so whoever proves one
///         leaves margins: no deposit within an hour of RECLAIM_AFTER (anyone may reclaim it then), no deposit its depositor
///         has queued (a queued deposit is taken in only through its entry), every queue entry that turns FORCE_DELAY old
///         before the block can land, and no more than it can land before its turn ends. A block that is refused is proven
///         again.
///
///         Anyone may post a spend to the queue (`force`). Every block takes the queue's next entries in order, the
///         block program taking each sound one and passing over the rest, and a block lands only if it reaches every
///         entry posted FORCE_DELAY or more before (or takes MAX_FORCED of them). So a leader cannot keep a spend out
///         of the chain and go on landing, and when the leaders stop landing anyone may.
///
///         A spend may send its exit's value into an operation on the chain's own pools instead of to an address: a swap,
///         or liquidity added or taken out (tacit-block-common `ops`). What it makes comes back as notes the block makes
///         for keys the spend's body names, and that value stays on the chain: it is paid out on L1 only when a note of it
///         exits. Shares of a pool never exit.
///
///         A block's calldata carries everything it publishes: new notes (leaf and a MEMO_LEN-byte memo each, sorted
///         by leaf), nullifiers (ascending, the order they enter the nullifier tree), anchors older than the block
///         program's recent roots, the deposits it took in, the exits it pays and the pools it changed (each as the block
///         leaves it, with the price its swaps cleared at), each list checked against the hash the proof commits. Anyone
///         can rebuild the chain's state from these lists alone. Their order says nothing of which spend an entry came
///         from; whoever proves a block does see that.
///
///         The binding every spend's body carries is derived here from the chain id and this contract's address,
///         and the genesis state from it, so a spend made for one deployment is void on any other.
///
///         `deposit` takes value and records (asset, value, commitment, body hash); a block's deposit record consumes
///         it, so the shield that spends it can only be the one the depositor's body named. A deposit no block has
///         taken in within RECLAIM_AFTER goes back to its depositor (a leader does not include one that old).
///         Exits are credited to their address and anyone may send a credit on with `withdraw`, so landing never
///         calls out to a token or a recipient and a recipient needs no gas of its own.
///
///         Values are in units of an asset, fixed when it is first deposited: 1 gwei of ETH; of a token with 10 to 36
///         decimals, 10^(decimals - 9) of its smallest units, else one. So a note holds up to 2^64 - 1 units.
contract TacitBlocks {
    /// The BN254 scalar field's modulus: asset fields and every committed field element are below it.
    uint256 internal constant R = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001;
    /// BabyJubJub's twisted Edwards coefficients (a x^2 + y^2 = 1 + d x^2 y^2 mod R), the curve of deposit commitments.
    uint256 internal constant JUB_A = 168700;
    uint256 internal constant JUB_D = 168696;
    bytes internal constant ASSET_TAG = "tacit-btc-pool-zk-asset-v1";
    bytes internal constant LIST_DOMAIN = "tacit-block-list-v1";
    bytes internal constant MEMO_DOMAIN = "tacit-block-memo-v1";
    bytes internal constant STATE_DOMAIN = "tacit-block-state-v1";
    bytes internal constant CHAIN_DOMAIN = "tacit-block-chain-v1";
    bytes internal constant QUEUE_DOMAIN = "tacit-block-queue-v1";
    /// The empty note tree's root, and the nullifier tree's before any spend (its head record alone), as the block
    /// program computes them (tacit-block-common `Notes::default`, `nf_genesis_root`).
    bytes32 internal constant EMPTY_NOTE_ROOT = 0x2f68a1c58e257e42a17a6c61dff5551ed560b9922ab119d5ac8e184c9734ead9;
    bytes32 internal constant NF_GENESIS_ROOT = 0xf17b0f821760732c27b2f8e967a3e18c976a57e176de5164378fdaf3e1796f0c;
    uint256 internal constant NOTE_TREE_DEPTH = 32;
    uint256 internal constant RECENT = 32;
    uint256 internal constant PUBLIC_WORDS = 13;
    uint256 internal constant DEPOSIT_LEN = 160;
    uint256 internal constant EXIT_LEN = 96;
    /// A pool a block changed (tacit-block-common `ops::change_bytes`): its two assets, reserves and shares, then its price.
    uint256 internal constant CHANGE_LEN = 176;
    uint256 internal constant ETH_UNIT = 1 gwei;
    /// Every memo's length (tacit-block-common MEMO_LEN), so a memo's size says nothing of what wrote it.
    uint256 public constant MEMO_LEN = 128;
    uint256 public constant RECLAIM_AFTER = 7 days;
    uint256 public constant MAX_WINDOW = 1 days;
    /// A posted spend (tacit-block-common `forced_parts`): publics (12 words) ‖ proof (2,080 bytes) ‖ hints (20 × 64) ‖ a memo
    /// per output slot ‖ the exit's address (20) ‖ salt (32) ‖ the deposit's opening (a flag, then value (u64 BE) and
    /// blinding (32)) ‖ the exit's opening ‖ for a spend that carries an operation, a 1, the operation (305 bytes at most, a
    /// removal's) and a memo for each receiver it names (three at most).
    uint256 internal constant FORCED_REST_AT = 12 * 32 + 2080 + 20 * 64 + 3 * MEMO_LEN;
    uint256 internal constant FORCED_MIN = FORCED_REST_AT + 20 + 32 + 1 + 1;
    uint256 internal constant FORCED_MAX = FORCED_MIN + 2 * (8 + 32) + 1 + 305 + 3 * MEMO_LEN;
    /// @notice A block that takes this many entries of the queue may leave overdue ones to the next.
    uint256 public constant MAX_FORCED = 16;
    uint256 public constant MIN_FORCE_DELAY = 10 minutes;
    uint256 public constant MAX_FORCE_DELAY = 1 days;

    ISP1BlockVerifier public immutable VERIFIER;
    /// @notice The block program's verifying key.
    bytes32 public immutable BLOCK_VKEY;
    /// @notice The spend relation the block program takes, as it commits it (its key's digest, hashed).
    bytes32 public immutable SPEND_VK;
    /// @notice Whose turn it is to land.
    ITurns public immutable TURNS;
    uint256 public immutable WINDOW;
    /// @notice How long after an entry is posted to the queue every block must reach it.
    uint256 public immutable FORCE_DELAY;
    /// @notice The binding every spend on this chain carries in its body.
    bytes32 public immutable CHAIN;

    /// @notice The digest of the state the next block must start from and the note root it holds.
    bytes32 public state;
    bytes32 public noteRoot;
    /// @notice How many blocks have landed, and when the last did.
    uint64 public height;
    uint64 public lastLanded;
    /// @notice How many spends have been posted to the queue, and how many of them the chain has taken or passed over.
    uint64 public queued;
    uint64 public queueDone;

    /// @notice Every note root a block has ended at: what an anchor older than the block program's recent roots
    ///         must be.
    mapping(bytes32 => bool) public knownRoot;
    struct Pending {
        address from;
        uint40 at;
        /// 1 + the queue entry its depositor posted to take it in (0 for none): until the chain reaches that entry no
        /// other spend may take the deposit in, and it cannot be reclaimed.
        uint56 forced;
    }
    /// @notice Deposits not yet taken in, by keccak256(asset, value, cx, cy, body): who made each and when.
    mapping(bytes32 => Pending) public pending;
    /// @notice The queue's hash after its first k entries (zero for none), as the block program chains it, and when
    ///         each entry (from zero) was posted.
    mapping(uint256 => bytes32) public queueHash;
    mapping(uint256 => uint256) public queuedAt;
    /// @notice The token an asset field stands for (the zero address for ETH) and its unit, once deposited.
    mapping(bytes32 => address) public tokenOf;
    mapping(bytes32 => uint256) public unitOf;
    /// @notice Exits credited and not yet sent, by token and recipient, in the token's own smallest units.
    mapping(address => mapping(address => uint256)) public owed;

    bool private transient locked;

    event Deposited(address indexed token, uint256 value, bytes32 cx, bytes32 cy, bytes32 body, address indexed from);
    event Landed(uint256 indexed height, bytes32 state, bytes32 noteRoot, address indexed by);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event Reclaimed(address indexed token, address indexed to, uint256 value);
    /// @notice The `index`th entry of the queue: what a block's builder hands the block program, and the memos it
    ///         publishes for the outputs of a spend the block takes.
    event Forced(uint256 indexed index, address indexed by, bytes payload);

    error Reentered();
    error BadVerifier();
    error BadTurns();
    error BadWindow();
    error BadValue();
    error BadCommitment();
    error DepositPending();
    error NotPending();
    error TooSoon();
    error TransferFailed();
    error NotYourTurn();
    error BadPublicValues();
    error NotOnTop();
    error WrongRelation();
    error BadList(uint8 list);
    error UnknownAnchor(bytes32 anchor);
    error NoSuchDeposit(uint256 deposit);
    error UnknownAsset(bytes32 asset);
    error BadAddress(uint256 exit);
    error BadForceDelay();
    error BadPayload();
    error NotDepositor();
    error DepositQueued();
    error BadQueue();
    error QueueOverdue();

    /// @notice The lists a block publishes, in the block program's committed order (`BlockData`): the new notes'
    ///         leaves (32 bytes each) and their memos (MEMO_LEN bytes each, in the same order), nullifiers, anchors,
    ///         deposits as asset ‖ value ‖ cx ‖ cy ‖ body (160 bytes each), exits as asset ‖ value ‖ address (96) and the
    ///         pools it changed as x ‖ y ‖ reserves and shares (u128 BE each) ‖ the price of x in y as numerator and
    ///         denominator, zero when nothing traded (CHANGE_LEN each, by pair).
    struct Lists {
        bytes leaves;
        bytes memos;
        bytes32[] nullifiers;
        bytes32[] anchors;
        bytes deposits;
        bytes exits;
        bytes pools;
    }

    modifier nonReentrant() {
        if (locked) revert Reentered();
        locked = true;
        _;
        locked = false;
    }

    /// @param verifier The immutable SP1 Groth16 verifier (never an upgradeable gateway: the deploy script pins its
    ///        codehash). @param turns Whose turn it is (TacitSeats). @param window How long after a landing only the
    ///        leader of the turn may land, at most MAX_WINDOW.
    /// @param forceDelay How long after an entry is posted to the queue every block must reach it: longer than a block
    ///        takes to prove, so a block proven before an entry was posted can still land.
    constructor(ISP1BlockVerifier verifier, bytes32 blockVkey, bytes32 spendVk, ITurns turns, uint256 window, uint256 forceDelay) {
        if (address(verifier).code.length == 0) revert BadVerifier();
        if (address(turns).code.length == 0) revert BadTurns();
        if (window > MAX_WINDOW) revert BadWindow();
        if (forceDelay < MIN_FORCE_DELAY || forceDelay > MAX_FORCE_DELAY) revert BadForceDelay();
        VERIFIER = verifier;
        BLOCK_VKEY = blockVkey;
        SPEND_VK = spendVk;
        TURNS = turns;
        WINDOW = window;
        FORCE_DELAY = forceDelay;
        bytes32 chain = sha256(abi.encodePacked(CHAIN_DOMAIN, block.chainid, address(this)));
        CHAIN = chain;
        // State::genesis(chain).digest(): the empty note tree (its root, no leaves, every filled node zero), the
        // nullifier tree holding its head record, the recent roots with the empty root newest, the binding, the
        // queue's start (no entries, hash zero) and no pools.
        state = sha256(
            abi.encodePacked(
                STATE_DOMAIN,
                EMPTY_NOTE_ROOT,
                uint64(0),
                new bytes(32 * NOTE_TREE_DEPTH),
                NF_GENESIS_ROOT,
                uint64(1),
                new bytes(32 * (RECENT - 1)),
                EMPTY_NOTE_ROOT,
                chain,
                uint64(0),
                bytes32(0),
                uint32(0)
            )
        );
        noteRoot = EMPTY_NOTE_ROOT;
        lastLanded = uint64(block.timestamp);
    }

    /// @notice The asset field the spend relation uses for `token` (the zero address for ETH):
    ///         SHA-256(ASSET_TAG ‖ token left-padded to 32 bytes), reduced mod r.
    function assetOf(address token) public pure returns (bytes32) {
        return bytes32(uint256(sha256(abi.encodePacked(ASSET_TAG, bytes32(uint256(uint160(token)))))) % R);
    }

    /// @notice Deposits `value` units of `token` (ETH as msg.value when `token` is zero) for the shield spend whose
    ///         deposit commitment is (cx, cy) and whose body hash is `body`: only that spend can take it in.
    function deposit(address token, uint256 value, bytes32 cx, bytes32 cy, bytes32 body) external payable nonReentrant {
        if (value == 0 || value > type(uint64).max) revert BadValue();
        if (!_onCurve(uint256(cx), uint256(cy)) || uint256(body) >= R) revert BadCommitment();
        bytes32 asset = assetOf(token);
        uint256 unit = unitOf[asset];
        if (unit == 0) {
            unit = _unitFor(token);
            unitOf[asset] = unit;
            tokenOf[asset] = token;
        }
        uint256 amount = value * unit;
        if (token == address(0)) {
            if (msg.value != amount) revert BadValue();
        } else {
            if (msg.value != 0) revert BadValue();
            uint256 before = IERC20Min(token).balanceOf(address(this));
            _call(token, abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount));
            if (IERC20Min(token).balanceOf(address(this)) - before != amount) revert BadValue();
        }
        bytes32 key = keccak256(abi.encode(asset, value, cx, cy, body));
        if (pending[key].from != address(0)) revert DepositPending();
        pending[key] = Pending(msg.sender, uint40(block.timestamp), 0);
        emit Deposited(token, value, cx, cy, body, msg.sender);
    }

    /// @notice Sends a deposit no block has taken in within RECLAIM_AFTER back to whoever made it, unless an entry its
    ///         depositor queued to take it in is still ahead of the chain. Anyone may call it.
    function reclaim(address token, uint256 value, bytes32 cx, bytes32 cy, bytes32 body) external nonReentrant {
        bytes32 asset = assetOf(token);
        bytes32 key = keccak256(abi.encode(asset, value, cx, cy, body));
        Pending memory p = pending[key];
        if (p.from == address(0)) revert NotPending();
        if (block.timestamp < uint256(p.at) + RECLAIM_AFTER) revert TooSoon();
        if (p.forced > queueDone) revert DepositQueued();
        delete pending[key];
        _pay(token, p.from, value * unitOf[asset]);
        emit Reclaimed(token, p.from, value);
    }

    /// @notice Posts a spend to the queue every block takes in order: publics ‖ proof ‖ hints ‖ a memo per output slot ‖
    ///         the rest of its body and openings (tacit-block-common `forced_parts`). The block program takes a spend whose
    ///         proof verifies, whose body and openings check out and whose notes are unspent, and passes over anything else.
    ///         What only this contract knows is checked here, so that no entry can make a block unlandable: a spend of notes
    ///         is proven against a note root a block ended at, an exit to an address is of an asset deposited before (one
    ///         into an operation stays on the chain), and a deposit is one the sender made and has no entry already queued
    ///         for (no other spend may then take it in before the chain reaches this entry). What is posted is public: a forced spend's nullifiers, outputs, memos, deposit and exit
    ///         are linked on L1 to one another and to the address that posts it, which for a spend a leader takes only the
    ///         block's prover sees, and a deposit's or exit's opening (its value) is in clear; the values of its notes stay
    ///         hidden. Bytes are queued as posted: the same spend posted twice, or with the flag bit halo2's point encoding
    ///         ignores flipped, is two entries, of which a block takes at most one.
    function force(bytes calldata payload) external nonReentrant {
        if (payload.length < FORCED_MIN || payload.length > FORCED_MAX) revert BadPayload();
        bytes32 asset = bytes32(payload[64:96]);
        if (bytes32(payload[96:128]) != 0 || bytes32(payload[128:160]) != 0) {
            bytes32 root = bytes32(payload[0:32]);
            if (!knownRoot[root]) revert UnknownAnchor(root);
        }
        // past the openings, an operation follows if a 1 does (as the block program parses it, which takes nothing after a
        // payment's openings)
        uint256 at = FORCED_REST_AT + 52;
        at += payload[at] == 0x01 ? 41 : 1;
        if (at >= payload.length) revert BadPayload();
        at += payload[at] == 0x01 ? 41 : 1;
        bool op = at < payload.length && payload[at] == 0x01;
        if (!op && !_isIdentity(payload[256:320]) && unitOf[asset] == 0) revert UnknownAsset(asset);
        uint256 i = queued;
        if (!_isIdentity(payload[320:384])) {
            if (payload[FORCED_REST_AT + 52] != 0x01) revert BadPayload();
            uint256 value = uint64(bytes8(payload[FORCED_REST_AT + 53:FORCED_REST_AT + 61]));
            Pending storage p = pending[keccak256(abi.encode(asset, value, bytes32(payload[320:352]), bytes32(payload[352:384]), bytes32(payload[32:64])))];
            if (p.from != msg.sender) revert NotDepositor();
            if (p.forced > queueDone) revert DepositQueued();
            p.forced = uint56(i + 1);
        }
        queueHash[i + 1] = sha256(abi.encodePacked(QUEUE_DOMAIN, queueHash[i], sha256(payload)));
        queuedAt[i] = block.timestamp;
        queued = uint64(i + 1);
        emit Forced(i, msg.sender, payload);
    }

    /// @notice Lands the next block: its proof, its thirteen public words and the lists it publishes.
    function land(bytes calldata publicValues, bytes calldata proof, Lists calldata lists) external nonReentrant {
        if (block.timestamp < uint256(lastLanded) + WINDOW) {
            address lead = TURNS.turn();
            if (lead != address(0) && msg.sender != lead) revert NotYourTurn();
        }
        if (publicValues.length != 32 * PUBLIC_WORDS) revert BadPublicValues();
        VERIFIER.verifyProof(BLOCK_VKEY, publicValues, proof);
        bytes32[13] memory w = abi.decode(publicValues, (bytes32[13]));
        if (w[0] != state || w[2] != noteRoot) revert NotOnTop();
        if (w[9] != SPEND_VK) revert WrongRelation();
        // how far through the queue the chain is after the block, and the queue's hash there (the program only moves
        // it on, from where the state digest says it was)
        uint256 done = uint256(w[10]);
        if (done < queueDone || done > queued || w[11] != queueHash[done]) revert BadQueue();
        if (done < queued && block.timestamp >= queuedAt[done] + FORCE_DELAY && done - queueDone < MAX_FORCED) revert QueueOverdue();

        _checkOutputs(lists.leaves, lists.memos, w[4]);
        if (_listHash(2, lists.nullifiers.length, abi.encodePacked(lists.nullifiers)) != w[5]) revert BadList(2);
        if (_listHash(3, lists.anchors.length, abi.encodePacked(lists.anchors)) != w[6]) revert BadList(3);
        for (uint256 i; i < lists.anchors.length; ++i) {
            if (!knownRoot[lists.anchors[i]]) revert UnknownAnchor(lists.anchors[i]);
        }

        bytes calldata deposits = lists.deposits;
        if (deposits.length % DEPOSIT_LEN != 0) revert BadList(4);
        uint256 nDeposits = deposits.length / DEPOSIT_LEN;
        if (_listHash(4, nDeposits, deposits) != w[7]) revert BadList(4);
        for (uint256 i; i < nDeposits; ++i) {
            bytes32 key = keccak256(deposits[DEPOSIT_LEN * i:DEPOSIT_LEN * (i + 1)]);
            Pending storage p = pending[key];
            if (p.from == address(0)) revert NoSuchDeposit(i);
            // one its depositor queued is taken in by the block that reaches the entry, or after it by any spend
            if (p.forced > done) revert DepositQueued();
            delete pending[key];
        }

        bytes calldata exits = lists.exits;
        if (exits.length % EXIT_LEN != 0) revert BadList(5);
        uint256 nExits = exits.length / EXIT_LEN;
        if (_listHash(5, nExits, exits) != w[8]) revert BadList(5);
        for (uint256 i; i < nExits; ++i) {
            bytes32 asset = bytes32(exits[EXIT_LEN * i:EXIT_LEN * i + 32]);
            uint256 unit = unitOf[asset];
            if (unit == 0) revert UnknownAsset(asset);
            uint256 to = uint256(bytes32(exits[EXIT_LEN * i + 64:EXIT_LEN * (i + 1)]));
            if (to >> 160 != 0 || to == 0) revert BadAddress(i);
            owed[tokenOf[asset]][address(uint160(to))] += uint256(bytes32(exits[EXIT_LEN * i + 32:EXIT_LEN * i + 64])) * unit;
        }
        // the pools are the block program's to check; they are published so anyone can rebuild them and a wallet can work out
        // what its operations made
        if (lists.pools.length % CHANGE_LEN != 0 || _listHash(6, lists.pools.length / CHANGE_LEN, lists.pools) != w[12]) revert BadList(6);

        state = w[1];
        noteRoot = w[3];
        knownRoot[w[3]] = true;
        queueDone = uint64(done);
        uint64 h = height + 1;
        height = h;
        lastLanded = uint64(block.timestamp);
        emit Landed(h, w[1], w[3], msg.sender);
    }

    /// @notice Sends `to` what exits have credited it in `token` (the zero address for ETH). Anyone may call it.
    function withdraw(address token, address to) external nonReentrant {
        uint256 amount = owed[token][to];
        owed[token][to] = 0;
        _pay(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    /// @dev The outputs list as the block program commits it (leaf ‖ memo hash, 64 bytes each), rebuilt from the
    ///      leaves and memos the calldata carries, checked against `want`.
    function _checkOutputs(bytes calldata leaves, bytes calldata memos, bytes32 want) internal pure {
        if (leaves.length % 32 != 0) revert BadList(1);
        uint256 n = leaves.length / 32;
        if (memos.length != n * MEMO_LEN) revert BadList(1);
        bytes memory items = new bytes(64 * n);
        for (uint256 i; i < n; ++i) {
            bytes32 leaf = bytes32(leaves[32 * i:32 * i + 32]);
            bytes32 m = sha256(abi.encodePacked(MEMO_DOMAIN, memos[MEMO_LEN * i:MEMO_LEN * (i + 1)]));
            assembly {
                let at := add(add(items, 32), mul(64, i))
                mstore(at, leaf)
                mstore(add(at, 32), m)
            }
        }
        if (_listHash(1, n, items) != want) revert BadList(1);
    }

    /// @dev Whether a public point (x ‖ y, 32-byte words) is the identity (0, 1), which stands for no exit or deposit.
    function _isIdentity(bytes calldata p) internal pure returns (bool) {
        return bytes32(p[0:32]) == 0 && uint256(bytes32(p[32:64])) == 1;
    }

    /// @dev A deposit commitment a shield could have: canonical coordinates on BabyJubJub, not the identity.
    function _onCurve(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= R || y >= R || (x == 0 && y == 1)) return false;
        uint256 xx = mulmod(x, x, R);
        uint256 yy = mulmod(y, y, R);
        return addmod(mulmod(JUB_A, xx, R), yy, R) == addmod(1, mulmod(JUB_D, mulmod(xx, yy, R), R), R);
    }

    /// @dev An asset's unit: 1 gwei of ETH; 10^(decimals - 9) of a token with 10 to 36 decimals, else one. Bounded so
    ///      no exit's amount (2^64 units at most) overflows when a block credits it, which would stop the chain.
    function _unitFor(address token) internal view returns (uint256) {
        if (token == address(0)) return ETH_UNIT;
        (bool ok, bytes memory ret) = token.staticcall(abi.encodeWithSelector(0x313ce567));
        if (!ok || ret.length < 32) return 1;
        uint256 d = abi.decode(ret, (uint256));
        return d > 9 && d <= 36 ? 10 ** (d - 9) : 1;
    }

    /// @dev SHA-256(LIST_DOMAIN ‖ tag ‖ count (u64 BE) ‖ items), the block program's `list_hash`.
    function _listHash(uint8 tag, uint256 count, bytes memory items) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(LIST_DOMAIN, tag, uint64(count), items));
    }

    function _pay(address token, address to, uint256 amount) internal {
        if (token == address(0)) {
            (bool ok,) = to.call{value: amount}("");
            if (!ok) revert TransferFailed();
        } else {
            _call(token, abi.encodeWithSelector(0xa9059cbb, to, amount));
        }
    }

    /// @dev A token call that must succeed and return true or nothing.
    function _call(address token, bytes memory data) internal {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory ret) = token.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
