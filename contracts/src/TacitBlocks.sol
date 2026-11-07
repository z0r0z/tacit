// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

interface ISP1BlockVerifier {
    function verifyProof(bytes32 programVKey, bytes calldata publicValues, bytes calldata proofBytes) external view;
}

interface IERC20Min {
    function balanceOf(address who) external view returns (uint256);
}

/// The confidential pool on Ethereum (V1): its deposit for a note (`wrap`), and an asset's registration, read once to check the
/// pool counts TAC as this chain does.
interface IConfidentialPool {
    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable;
    function assets(bytes32 assetId)
        external
        view
        returns (bool registered, address underlying, uint256 unitScale, bytes32 crossChainLink, bool poolMinted, uint8 decimals);
}

/// Whose turn it is to land (TacitSeats: TAC stakers by turns). `turn` may keep what it needs to say so (an epoch's seed); zero means no
/// one leads now.
interface ITurns {
    function turn() external returns (address);
}

/// @notice Lands Tacit blocks on Ethereum and holds the TAC their notes are worth.
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
///         The chain holds one asset, TAC, and keeps no liquidity of its own. A spend may send its exit's value into the
///         confidential pool on Ethereum (`CONFIDENTIAL`) instead of to an address: a hop, a deposit there for a note the
///         spend's body names by that pool's commitment, so the value moves from this chain's notes to that pool's with no
///         address of the spender's in between, joining that pool's liquidity and anonymity set.
///
///         A spend may also put its value in a lock, the chain's half of an atomic swap with another chain (the fast bridge's
///         adaptor swap): its recipient claims it with a BIP-340 signature before a deadline, the block publishing the
///         signature (from which the swap's counterparty, holding the recipient's adapted pre-signature, reads the swap's
///         secret), and from the deadline anyone may refund it to the locker. A block names a time and lands only within
///         TIME_WINDOW of it; the block program decides claims and refunds by that time alone.
///
///         A block's calldata carries everything it publishes: new notes (leaf and a MEMO_LEN-byte memo each, sorted
///         by leaf), nullifiers (ascending, the order they enter the nullifier tree), anchors older than the block
///         program's recent roots, the deposits it took in, the exits it pays, the hops it sends and its claims'
///         signatures, each list checked against the hash the proof commits. Anyone can rebuild the chain's state from these lists alone. Their order
///         says nothing of which spend an entry came from; whoever proves a block does see that.
///
///         The binding every spend's body carries is derived here from the chain id and this contract's address,
///         and the genesis state from it, so a spend made for one deployment is void on any other.
///
///         `deposit` takes TAC and records (value, commitment, body hash); a block's deposit record consumes it, so the
///         shield that spends it can only be the one the depositor's body named. A deposit no block has taken in within
///         RECLAIM_AFTER goes back to its depositor (a leader does not include one that old). Exits are credited to their
///         address and anyone may send a credit on with `withdraw`; hops are kept and anyone may send one on with
///         `sendHop`. So landing never calls out to a token or a pool, and a recipient needs no gas of its own.
///
///         Values are in units of 10^-8 TAC (UNIT of its smallest units), the unit the confidential pool and Bitcoin
///         count TAC in, so a value moves between them unchanged. A note holds up to 2^64 - 1 units.
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
    uint256 internal constant PUBLIC_WORDS = 15;
    uint256 internal constant DEPOSIT_LEN = 160;
    uint256 internal constant EXIT_LEN = 96;
    /// A hop (tacit-block-common `ops::hop_bytes`): asset ‖ value ‖ the confidential pool's commitment.
    uint256 internal constant HOP_LEN = 96;
    /// A claim's signature (R.x ‖ s).
    uint256 internal constant CLAIM_LEN = 64;
    /// @notice How long after the time a block names it may land (tacit-block-common `lock::TIME_WINDOW`).
    uint256 public constant TIME_WINDOW = 1 hours;
    /// @notice A unit of value: 10^-8 TAC in the token's smallest units.
    uint256 public constant UNIT = 1e10;
    /// Every memo's length (tacit-block-common MEMO_LEN), so a memo's size says nothing of what wrote it.
    uint256 public constant MEMO_LEN = 64;
    uint256 public constant RECLAIM_AFTER = 7 days;
    uint256 public constant MAX_WINDOW = 1 days;
    /// A posted spend (tacit-block-common `forced_parts`): publics (12 words) ‖ proof (2,080 bytes) ‖ hints (20 × 64) ‖ a memo
    /// per output slot ‖ the exit's address (20) ‖ salt (32) ‖ the deposit's opening (a flag, then value (u64 BE) and
    /// blinding (32)) ‖ the exit's opening ‖ for an operation, a 1 and the operation (a hop's 33 bytes, a lock's 265) and, for a
    /// lock, the memo of its leaf.
    uint256 internal constant FORCED_REST_AT = 12 * 32 + 2080 + 20 * 64 + 3 * MEMO_LEN;
    uint256 internal constant FORCED_MIN = FORCED_REST_AT + 20 + 32 + 1 + 1;
    uint256 internal constant FORCED_MAX = FORCED_MIN + 2 * (8 + 32) + 1 + 265 + MEMO_LEN;
    /// A claim or refund posted to the queue (tacit-block-common `lock::forced_settle`): SETTLE_MARK ‖ kind ‖ asset ‖ value (u64)
    /// ‖ the lock's terms (232) ‖ index (u64) ‖ the root its path leads to ‖ the path (32 × 32) ‖ a claim's signature ‖ the memo of
    /// the note it makes.
    bytes32 internal constant SETTLE_MARK = bytes32(type(uint256).max);
    uint256 internal constant SETTLE_ROOT_AT = 32 + 1 + 32 + 8 + 232 + 8;
    uint256 internal constant SETTLE_REFUND_LEN = SETTLE_ROOT_AT + 32 + 32 * 32 + MEMO_LEN;
    uint256 internal constant SETTLE_CLAIM_LEN = SETTLE_REFUND_LEN + 64;
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
    /// @notice The TAC token, and its asset field as the spend relation uses it.
    address public immutable TAC;
    bytes32 public immutable TAC_ASSET;
    /// @notice The confidential pool hops go into, and TAC's id there.
    IConfidentialPool public immutable CONFIDENTIAL;
    bytes32 public immutable CONFIDENTIAL_TAC;

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
    /// @notice Deposits not yet taken in, by keccak256(TAC_ASSET, value, cx, cy, body): who made each and when.
    mapping(bytes32 => Pending) public pending;
    /// @notice The queue's hash after its first k entries (zero for none), as the block program chains it, and when
    ///         each entry (from zero) was posted.
    mapping(uint256 => bytes32) public queueHash;
    mapping(uint256 => uint256) public queuedAt;
    /// @notice TAC exits have credited and not yet sent, by recipient, in the token's smallest units.
    mapping(address => uint256) public owed;
    /// @notice Hops landed and not yet sent into the confidential pool, by keccak256(value, commit): how many.
    mapping(bytes32 => uint256) public hops;

    bool private transient locked;

    event Deposited(uint256 value, bytes32 cx, bytes32 cy, bytes32 body, address indexed from);
    event Landed(uint256 indexed height, bytes32 state, bytes32 noteRoot, address indexed by);
    event Withdrawn(address indexed to, uint256 amount);
    event Reclaimed(address indexed to, uint256 value);
    event Hopped(uint256 value, bytes32 commit);
    /// @notice The `index`th entry of the queue: what a block's builder hands the block program, and the memos it
    ///         publishes for the outputs of a spend the block takes.
    event Forced(uint256 indexed index, address indexed by, bytes payload);

    error Reentered();
    error BadVerifier();
    error BadTurns();
    error BadWindow();
    error BadToken();
    error BadPool();
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
    error NotTac(bytes32 asset);
    error BadAddress(uint256 exit);
    error BadForceDelay();
    error BadPayload();
    error NotDepositor();
    error DepositQueued();
    error BadQueue();
    error QueueOverdue();
    error NoSuchHop();
    error BadTime();

    /// @notice The lists a block publishes, in the block program's committed order (`BlockData`): the new notes'
    ///         leaves (32 bytes each) and their memos (MEMO_LEN bytes each, in the same order), nullifiers, anchors,
    ///         deposits as asset ‖ value ‖ cx ‖ cy ‖ body (160 bytes each), exits as asset ‖ value ‖ address (96),
    ///         hops as asset ‖ value ‖ the confidential pool's commitment (96) and claims' signatures (64).
    struct Lists {
        bytes leaves;
        bytes memos;
        bytes32[] nullifiers;
        bytes32[] anchors;
        bytes deposits;
        bytes exits;
        bytes hops;
        bytes claims;
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
    /// @param tac The TAC token. @param confidential The confidential pool hops go into, which must count TAC (`confidentialTac`)
    ///        as this chain does: in UNIT, minting and burning the token itself.
    constructor(
        ISP1BlockVerifier verifier,
        bytes32 blockVkey,
        bytes32 spendVk,
        ITurns turns,
        uint256 window,
        uint256 forceDelay,
        address tac,
        IConfidentialPool confidential,
        bytes32 confidentialTac
    ) {
        if (address(verifier).code.length == 0) revert BadVerifier();
        if (address(turns).code.length == 0) revert BadTurns();
        if (window > MAX_WINDOW) revert BadWindow();
        if (forceDelay < MIN_FORCE_DELAY || forceDelay > MAX_FORCE_DELAY) revert BadForceDelay();
        if (tac.code.length == 0) revert BadToken();
        (bool registered, address underlying, uint256 unitScale,, bool poolMinted,) = confidential.assets(confidentialTac);
        if (!registered || underlying != tac || unitScale != UNIT || !poolMinted) revert BadPool();
        VERIFIER = verifier;
        BLOCK_VKEY = blockVkey;
        SPEND_VK = spendVk;
        TURNS = turns;
        WINDOW = window;
        FORCE_DELAY = forceDelay;
        TAC = tac;
        TAC_ASSET = assetOf(tac);
        CONFIDENTIAL = confidential;
        CONFIDENTIAL_TAC = confidentialTac;
        bytes32 chain = sha256(abi.encodePacked(CHAIN_DOMAIN, block.chainid, address(this)));
        CHAIN = chain;
        // State::genesis(chain).digest(): the empty note tree (its root, no leaves, every filled node zero), the
        // nullifier tree holding its head record, the recent roots with the empty root newest, the binding, and the
        // queue's start (no entries, hash zero).
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
                bytes32(0)
            )
        );
        noteRoot = EMPTY_NOTE_ROOT;
        lastLanded = uint64(block.timestamp);
    }

    /// @notice The asset field the spend relation uses for `token`: SHA-256(ASSET_TAG ‖ token left-padded to 32 bytes),
    ///         reduced mod r.
    function assetOf(address token) public pure returns (bytes32) {
        return bytes32(uint256(sha256(abi.encodePacked(ASSET_TAG, bytes32(uint256(uint160(token)))))) % R);
    }

    /// @notice Deposits `value` units of TAC (approved to this contract) for the shield spend whose deposit commitment is
    ///         (cx, cy) and whose body hash is `body`: only that spend can take it in.
    function deposit(uint256 value, bytes32 cx, bytes32 cy, bytes32 body) external nonReentrant {
        if (value == 0 || value > type(uint64).max) revert BadValue();
        if (!_onCurve(uint256(cx), uint256(cy)) || uint256(body) >= R) revert BadCommitment();
        bytes32 key = keccak256(abi.encode(TAC_ASSET, value, cx, cy, body));
        if (pending[key].from != address(0)) revert DepositPending();
        uint256 amount = value * UNIT;
        uint256 before = IERC20Min(TAC).balanceOf(address(this));
        _call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount));
        if (IERC20Min(TAC).balanceOf(address(this)) - before != amount) revert BadValue();
        pending[key] = Pending(msg.sender, uint40(block.timestamp), 0);
        emit Deposited(value, cx, cy, body, msg.sender);
    }

    /// @notice Sends a deposit no block has taken in within RECLAIM_AFTER back to whoever made it, unless an entry its
    ///         depositor queued to take it in is still ahead of the chain. Anyone may call it.
    function reclaim(uint256 value, bytes32 cx, bytes32 cy, bytes32 body) external nonReentrant {
        bytes32 key = keccak256(abi.encode(TAC_ASSET, value, cx, cy, body));
        Pending memory p = pending[key];
        if (p.from == address(0)) revert NotPending();
        if (block.timestamp < uint256(p.at) + RECLAIM_AFTER) revert TooSoon();
        if (p.forced > queueDone) revert DepositQueued();
        delete pending[key];
        _call(abi.encodeWithSelector(0xa9059cbb, p.from, value * UNIT));
        emit Reclaimed(p.from, value);
    }

    /// @notice Posts a spend to the queue every block takes in order: publics ‖ proof ‖ hints ‖ a memo per output slot ‖
    ///         the rest of its body and openings (tacit-block-common `forced_parts`). The block program takes a spend whose
    ///         proof verifies, whose body and openings check out and whose notes are unspent, and passes over anything else.
    ///         What only this contract knows is checked here, so that no entry can make a block unlandable: a spend of notes
    ///         is proven against a note root a block ended at, an exit or a hop is of TAC, and a deposit is one the sender
    ///         made and has no entry already queued for (no other spend may then take it in before the chain reaches this
    ///         entry). What is posted is public: a forced spend's nullifiers, outputs, memos, deposit, exit and hop are linked
    ///         on L1 to one another and to the address that posts it, which for a spend a leader takes only the block's prover
    ///         sees, and a deposit's or exit's opening (its value) is in clear; the values of its notes stay hidden. Bytes are
    ///         queued as posted: the same spend posted twice, or with the flag bit halo2's point encoding ignores flipped, is
    ///         two entries, of which a block takes at most one. A claim or refund of a lock may be posted too (SETTLE_MARK ‖ the
    ///         settle ‖ the memo of the note it makes), shown against a root a block ended at; a block takes it if its time
    ///         allows (a claim while the block lands before the deadline, a refund from the deadline on) and passes it over
    ///         otherwise, so a claim is posted with time to spare: FORCE_DELAY and TIME_WINDOW before the deadline.
    function force(bytes calldata payload) external nonReentrant {
        if (payload.length >= 32 && bytes32(payload[0:32]) == SETTLE_MARK) {
            if (payload.length != SETTLE_CLAIM_LEN && payload.length != SETTLE_REFUND_LEN) revert BadPayload();
            bytes32 settleRoot = bytes32(payload[SETTLE_ROOT_AT:SETTLE_ROOT_AT + 32]);
            if (!knownRoot[settleRoot]) revert UnknownAnchor(settleRoot);
            _enqueue(payload);
            return;
        }
        if (payload.length < FORCED_MIN || payload.length > FORCED_MAX) revert BadPayload();
        bytes32 asset = bytes32(payload[64:96]);
        if (bytes32(payload[96:128]) != 0 || bytes32(payload[128:160]) != 0) {
            bytes32 root = bytes32(payload[0:32]);
            if (!knownRoot[root]) revert UnknownAnchor(root);
        }
        if (!_isIdentity(payload[256:320]) && asset != TAC_ASSET) revert NotTac(asset);
        uint256 i = queued;
        if (!_isIdentity(payload[320:384])) {
            if (payload[FORCED_REST_AT + 52] != 0x01) revert BadPayload();
            uint256 value = uint64(bytes8(payload[FORCED_REST_AT + 53:FORCED_REST_AT + 61]));
            Pending storage p = pending[keccak256(abi.encode(asset, value, bytes32(payload[320:352]), bytes32(payload[352:384]), bytes32(payload[32:64])))];
            if (p.from != msg.sender) revert NotDepositor();
            if (p.forced > queueDone) revert DepositQueued();
            p.forced = uint56(i + 1);
        }
        _enqueue(payload);
    }

    function _enqueue(bytes calldata payload) internal {
        uint256 i = queued;
        queueHash[i + 1] = sha256(abi.encodePacked(QUEUE_DOMAIN, queueHash[i], sha256(payload)));
        queuedAt[i] = block.timestamp;
        queued = uint64(i + 1);
        emit Forced(i, msg.sender, payload);
    }

    /// @notice Lands the next block: its proof, its fifteen public words and the lists it publishes.
    function land(bytes calldata publicValues, bytes calldata proof, Lists calldata lists) external nonReentrant {
        if (block.timestamp < uint256(lastLanded) + WINDOW) {
            address lead = TURNS.turn();
            if (lead != address(0) && msg.sender != lead) revert NotYourTurn();
        }
        if (publicValues.length != 32 * PUBLIC_WORDS) revert BadPublicValues();
        VERIFIER.verifyProof(BLOCK_VKEY, publicValues, proof);
        bytes32[15] memory w = abi.decode(publicValues, (bytes32[15]));
        if (w[0] != state || w[2] != noteRoot) revert NotOnTop();
        // the time the block names, by which its claims and refunds were decided
        if (block.timestamp < uint256(w[14]) || block.timestamp > uint256(w[14]) + TIME_WINDOW) revert BadTime();
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
            if (asset != TAC_ASSET) revert NotTac(asset);
            uint256 to = uint256(bytes32(exits[EXIT_LEN * i + 64:EXIT_LEN * (i + 1)]));
            if (to >> 160 != 0 || to == 0) revert BadAddress(i);
            owed[address(uint160(to))] += uint256(bytes32(exits[EXIT_LEN * i + 32:EXIT_LEN * i + 64])) * UNIT;
        }

        bytes calldata hopList = lists.hops;
        if (hopList.length % HOP_LEN != 0) revert BadList(6);
        uint256 nHops = hopList.length / HOP_LEN;
        if (_listHash(6, nHops, hopList) != w[12]) revert BadList(6);
        for (uint256 i; i < nHops; ++i) {
            bytes32 asset = bytes32(hopList[HOP_LEN * i:HOP_LEN * i + 32]);
            if (asset != TAC_ASSET) revert NotTac(asset);
            hops[keccak256(hopList[HOP_LEN * i + 32:HOP_LEN * (i + 1)])] += 1;
        }
        // the claims' signatures, published for the swaps' counterparties
        if (lists.claims.length % CLAIM_LEN != 0 || _listHash(7, lists.claims.length / CLAIM_LEN, lists.claims) != w[13]) revert BadList(7);

        state = w[1];
        noteRoot = w[3];
        knownRoot[w[3]] = true;
        queueDone = uint64(done);
        uint64 h = height + 1;
        height = h;
        lastLanded = uint64(block.timestamp);
        emit Landed(h, w[1], w[3], msg.sender);
    }

    /// @notice Sends `to` the TAC exits have credited it. Anyone may call it.
    function withdraw(address to) external nonReentrant {
        uint256 amount = owed[to];
        owed[to] = 0;
        _call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        emit Withdrawn(to, amount);
    }

    /// @notice Sends a landed hop of `value` units into the confidential pool, as its deposit for `commit` (the pool burns the
    ///         TAC from this contract and records the deposit; the note it names is made there when it is wrapped in). Anyone
    ///         may call it.
    function sendHop(uint256 value, bytes32 commit) external nonReentrant {
        _sendHop(value, commit);
    }

    /// @notice Sends several landed hops on in one transaction.
    function sendHops(uint256[] calldata values, bytes32[] calldata commits) external nonReentrant {
        if (values.length != commits.length) revert NoSuchHop();
        for (uint256 i; i < values.length; ++i) {
            _sendHop(values[i], commits[i]);
        }
    }

    function _sendHop(uint256 value, bytes32 commit) internal {
        bytes32 key = keccak256(abi.encode(value, commit));
        if (hops[key] == 0) revert NoSuchHop();
        hops[key] -= 1;
        CONFIDENTIAL.wrap(CONFIDENTIAL_TAC, value * UNIT, commit);
        emit Hopped(value, commit);
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

    /// @dev SHA-256(LIST_DOMAIN ‖ tag ‖ count (u64 BE) ‖ items), the block program's `list_hash`.
    function _listHash(uint8 tag, uint256 count, bytes memory items) internal pure returns (bytes32) {
        return sha256(abi.encodePacked(LIST_DOMAIN, tag, uint64(count), items));
    }

    /// @dev A TAC call that must succeed and return true or nothing.
    function _call(bytes memory data) internal {
        (bool ok, bytes memory ret) = TAC.call(data);
        if (!ok || (ret.length != 0 && !abi.decode(ret, (bool)))) revert TransferFailed();
    }
}
