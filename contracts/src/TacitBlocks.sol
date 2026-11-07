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

/// A deposit's inbox: an address TAC can be paid to with no approval and no call (the confidential pool's unwrap mints to
/// an address and nothing more), its own for one shield spend. `TacitBlocks.sweep` creates it at its CREATE2 address; creating
/// it hands everything it holds to the chain, and it is left with a single INVALID byte of code, so it can be created only once
/// and no reclaim can be paid back to it.
contract TacitInbox {
    constructor() {
        address tac = TacitBlocks(msg.sender).TAC();
        (bool ok, bytes memory ret) = tac.call(abi.encodeWithSelector(0x70a08231, address(this)));
        require(ok && ret.length == 32);
        uint256 held = abi.decode(ret, (uint256));
        // a holder's permitted TAC (`sweepWithPermit`): the permit names this inbox, so it can fund this shield alone, and only what
        // the inbox lacks of it is pulled (an inbox paid another way, by an unwrap or a transfer, takes nothing more)
        (address from, uint256 pull) = TacitBlocks(msg.sender).pullOrder();
        if (pull > held) {
            (ok, ret) = tac.call(abi.encodeWithSelector(0x23b872dd, from, msg.sender, pull - held));
            require(ok && (ret.length == 0 || abi.decode(ret, (bool))));
        }
        (ok, ret) = tac.call(abi.encodeWithSelector(0xa9059cbb, msg.sender, held));
        require(ok && (ret.length == 0 || abi.decode(ret, (bool))));
        assembly {
            mstore8(0, 0xfe)
            return(0, 1)
        }
    }
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
///         Notes count shares of the chain's pool (`pool` / `shares`, public word 18): deposits buy them, exits, hops and migrations
///         pay out at their worth less the block program's exit fee, and what stays raises every share's worth.
///         `deposit` takes TAC and records (shares, amount, commitment, body hash); a block's deposit record consumes it, so the
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
    uint256 internal constant PUBLIC_WORDS = 19;
    uint256 internal constant DEPOSIT_LEN = 192;
    uint256 internal constant EXIT_LEN = 96;
    /// A hop (tacit-block-common `ops::hop_bytes`): asset ‖ value ‖ the confidential pool's commitment.
    uint256 internal constant HOP_LEN = 96;
    /// A migration (successor ‖ the note it makes there) and a successor's total for a block (its address, left-padded ‖ value).
    uint256 internal constant MIGRATION_LEN = 52;
    uint256 internal constant MIGRATION_TOTAL_LEN = 64;
    /// A claim's signature (R.x ‖ s).
    uint256 internal constant CLAIM_LEN = 64;
    /// What a block whose lists travel in blobs shows for each blob: its KZG commitment (48), the point the program opened it at
    /// (32), the value there (32) and the proof (48).
    uint256 internal constant BLOB_OPENING_LEN = 160;
    address internal constant POINT_EVALUATION = address(0x0a);
    /// @notice How long after the time a block names it may land (tacit-block-common `lock::TIME_WINDOW`).
    uint256 public constant TIME_WINDOW = 1 hours;
    /// @notice A unit of value: 10^-8 TAC in the token's smallest units.
    uint256 public constant UNIT = 1e10;
    /// Every memo's length (tacit-block-common MEMO_LEN), so a memo's size says nothing of what wrote it.
    uint256 public constant MEMO_LEN = 1152;
    uint256 public constant RECLAIM_AFTER = 7 days;
    uint256 public constant MAX_WINDOW = 1 days;
    /// A posted spend (tacit-block-common `forced_parts`): publics (12 words) ‖ proof (2,080 bytes) ‖ hints (20 × 64) ‖ a memo
    /// per output slot ‖ the exit's address (20) ‖ salt (32) ‖ the deposit's opening (a flag, then shares (u64 BE), blinding (32)
    /// and the TAC amount (u64 BE)) ‖ the exit's opening ‖ for an operation, a 1 and the operation (a hop's 33 bytes, a lock's 265, a
    /// migration's 53, a pool share's 1) and, for a lock, the memo of its leaf.
    uint256 internal constant FORCED_REST_AT = 12 * 32 + 2080 + 20 * 64 + 3 * MEMO_LEN;
    uint256 internal constant FORCED_MIN = FORCED_REST_AT + 20 + 32 + 1 + 1;
    uint256 internal constant FORCED_MAX = FORCED_MIN + 2 * (8 + 32 + 8) + 1 + 265 + MEMO_LEN;
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
    /// @notice Deposits not yet taken in, by keccak256(TAC_ASSET, shares, cx, cy, body, amount) (the record the block program
    ///         publishes): who made each and when.
    mapping(bytes32 => Pending) public pending;
    /// @notice The queue's hash after its first k entries (zero for none), as the block program chains it, and when
    ///         each entry (from zero) was posted.
    mapping(uint256 => bytes32) public queueHash;
    mapping(uint256 => uint256) public queuedAt;
    /// @notice TAC exits have credited and not yet sent, by recipient, in the token's smallest units.
    mapping(address => uint256) public owed;
    /// @notice Hops landed and not yet sent into the confidential pool, by keccak256(value, commit): how many.
    mapping(bytes32 => uint256) public hops;
    /// @notice The hash of each landed block's migrations (the block program's list tag 8, `SHA-256("tacit-block-list-v1" ‖ 8 ‖
    ///         count ‖ successor ‖ note …)`), by height: a successor chain makes the notes of those naming it once it has been shown
    ///         a list with this hash. The TAC they hold was sent to it as the block landed (`Migrated`).
    mapping(uint256 => bytes32) public migrationsOf;
    /// @notice What each landed block moved to each successor, in units (its total, sent to it as the block landed): a successor
    ///         makes notes worth no more than this from a block. Each move it makes one from is a position in that block's list,
    ///         used once; its item (`SHA-256("tacit-block-migrate-v1" ‖ to ‖ note ‖ value)`) binds the note and the value.
    mapping(uint256 => mapping(address => uint256)) public migrated;
    /// @notice What the chain's notes are worth, in units: the TAC deposits blocks took in less the exits, hops and migrations they
    ///         paid out. A block that would take out more than this, or whose pool (public word 18) is not this, cannot land, whatever
    ///         its proof says (the block program keeps both, so this only ever stops a block if the program or the verifier were wrong).
    uint256 public inChain;
    /// @notice The TAC behind every note (units) and the shares the notes count, as the last block left them: a share is worth
    ///         pool / shares units (with the block program's virtual unit of pool and shares counted). It only rises: deposits buy shares at it, exits, hops and migrations
    ///         pay out at it less the program's exit fee, and spends give the holders pool shares.
    uint64 public pool;
    uint64 public shares;
    /// The units of pool and shares the block program's rate counts that no note holds (its VIRTUAL).
    uint256 internal constant VIRTUAL = 1e8;
    address private transient pullFrom;
    uint256 private transient pullAmount;

    /// @notice keccak256 of TacitInbox's creation code, for `inbox`; and the code a created inbox is left with.
    bytes32 public immutable INBOX_INIT_HASH = keccak256(type(TacitInbox).creationCode);
    bytes32 public constant INBOX_CODEHASH = keccak256(hex"fe");

    bool private transient locked;

    event Deposited(uint256 shares, uint256 amount, bytes32 cx, bytes32 cy, bytes32 body, address indexed from);
    event Landed(uint256 indexed height, bytes32 state, bytes32 noteRoot, address indexed by);
    event Withdrawn(address indexed to, uint256 amount);
    event Reclaimed(address indexed to, uint256 amount);
    /// @notice A deposit swept in from its inbox, and the confidential pool deposit (`back`) it goes back to if no block takes it.
    event Swept(address indexed inbox, bytes32 back);
    /// @notice A swept deposit no block took, sent back into the confidential pool for `back`.
    event Returned(uint256 amount, bytes32 back);
    event Hopped(uint256 value, bytes32 commit);
    /// @notice A block's moves to the successor chain `to`, `value` units in all, sent to it as the block landed.
    event Migrated(uint256 indexed height, address indexed to, uint256 value);
    /// @notice The confidential pool refused a hop's deposit (one for `commit` already exists there): the hop stays, to be sent again.
    event HopRefused(uint256 value, bytes32 commit);
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
    error BadBlob(uint256 blob);
    error NotInbox();
    error SweptDeposit();
    error Insolvent();
    error HopNotTaken();
    error TooLate();

    /// @notice The lists a block publishes, in the block program's committed order (`BlockData`): the new notes'
    ///         leaves (32 bytes each) and their memos (MEMO_LEN bytes each, in the same order), nullifiers, anchors,
    ///         deposits as asset ‖ shares ‖ cx ‖ cy ‖ body ‖ amount (192 bytes each), exits as asset ‖ amount ‖ address (96),
    ///         hops as asset ‖ value ‖ the confidential pool's commitment (96), claims' signatures (64) and, for a block whose
    ///         notes, memos, nullifiers and claims travel in EIP-4844 blobs instead (its public words say so), each blob's opening.
    struct Lists {
        bytes leaves;
        bytes memos;
        bytes32[] nullifiers;
        bytes32[] anchors;
        bytes deposits;
        bytes exits;
        bytes hops;
        bytes claims;
        bytes blobs;
        bytes migrations;
        bytes migrationTotals;
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
                bytes32(0),
                uint64(0),
                uint64(0)
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

    /// @notice Deposits `amount` units of TAC (approved to this contract) for the shield spend that buys `shareCount` shares with it and
    ///         whose deposit commitment is (cx, cy) and body hash `body`: only that spend can take it in, and only while `amount` buys
    ///         its shares at the chain's rate (`pool` / `shares`, which only rises), so a wallet pays a little over.
    function deposit(uint256 shareCount, uint256 amount, bytes32 cx, bytes32 cy, bytes32 body) external nonReentrant {
        bytes32 key = _depositKey(shareCount, amount, cx, cy, body);
        if (pending[key].from != address(0)) revert DepositPending();
        uint256 before = IERC20Min(TAC).balanceOf(address(this));
        _call(abi.encodeWithSelector(0x23b872dd, msg.sender, address(this), amount * UNIT));
        if (IERC20Min(TAC).balanceOf(address(this)) - before != amount * UNIT) revert BadValue();
        pending[key] = Pending(msg.sender, uint40(block.timestamp), 0);
        emit Deposited(shareCount, amount, cx, cy, body, msg.sender);
    }

    /// @notice Where TAC is paid for a shield spend with no approval and no call: the confidential pool unwraps straight to it, anyone
    ///         transfers to it, or a holder permits it (`sweepWithPermit`). `back` is a confidential pool deposit commitment the TAC
    ///         goes back into if no block takes the deposit in (`giveBack`); it is fixed by the address, so whoever paid the inbox
    ///         decides it and no one else can change it.
    function inbox(uint256 shareCount, uint256 amount, bytes32 cx, bytes32 cy, bytes32 body, bytes32 back) public view returns (address) {
        bytes32 salt = keccak256(abi.encode(TAC_ASSET, shareCount, amount, cx, cy, body, back));
        return address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, INBOX_INIT_HASH)))));
    }

    /// @notice Takes a paid inbox's TAC in as the deposit for its shield spend (what `deposit` does for TAC approved here).
    ///         Anyone may call it, a leader before it lands the spend. More than `amount` units in the inbox stays with the chain.
    ///         Anyone may queue the spend that takes a swept deposit in (`force`): only that spend can, its body being the
    ///         deposit's. If no block takes it in within RECLAIM_AFTER, anyone sends it back into the confidential pool for
    ///         `back`. If the spend's key is already held by a deposit made with `deposit`, the inbox's TAC goes back into the
    ///         confidential pool at once. An inbox is created once: TAC paid to it after its sweep stays there.
    function sweep(uint256 shareCount, uint256 amount, bytes32 cx, bytes32 cy, bytes32 body, bytes32 back) external nonReentrant {
        _sweep(shareCount, amount, cx, cy, body, back, 0);
    }

    /// @notice A shield with no ETH: `owner` signed an ERC-2612 permit for its inbox (the spender) of `amount` units of TAC and
    ///         `fee` more, and whoever sends this, paying the gas, takes the fee. Creating the inbox pulls the permitted TAC, and
    ///         the permit names the inbox, which names the shield: no one can put the TAC to any other use. A permit already used
    ///         (front-run) is passed over and the allowance it left is used. Only what the inbox lacks is pulled; an inbox that already
    ///         holds more than the deposit pays the caller the excess, up to `fee`, as `sweep` would leave it with the chain.
    function sweepWithPermit(
        uint256 shareCount,
        uint256 amount,
        bytes32 cx,
        bytes32 cy,
        bytes32 body,
        bytes32 back,
        address owner,
        uint256 fee,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        address box = inbox(shareCount, amount, cx, cy, body, back);
        (bool ok,) = TAC.call(abi.encodeWithSelector(0xd505accf, owner, box, amount * UNIT + fee, deadline, v, r, s));
        ok;
        pullFrom = owner;
        pullAmount = amount * UNIT + fee;
        _sweep(shareCount, amount, cx, cy, body, back, fee);
        pullFrom = address(0);
        pullAmount = 0;
        if (fee != 0) _call(abi.encodeWithSelector(0xa9059cbb, msg.sender, fee));
    }

    /// @notice What an inbox being created pulls, and from whom (`sweepWithPermit`); nothing otherwise.
    function pullOrder() external view returns (address, uint256) {
        return (pullFrom, pullAmount);
    }

    function _sweep(uint256 shareCount, uint256 amount, bytes32 cx, bytes32 cy, bytes32 body, bytes32 back, uint256 fee) internal {
        bytes32 key = _depositKey(shareCount, amount, cx, cy, body);
        uint256 before = IERC20Min(TAC).balanceOf(address(this));
        address box = address(new TacitInbox{salt: keccak256(abi.encode(TAC_ASSET, shareCount, amount, cx, cy, body, back))}());
        if (IERC20Min(TAC).balanceOf(address(this)) - before < amount * UNIT + fee) revert BadValue();
        if (pending[key].from != address(0)) {
            // another deposit holds the spend's key (made with `deposit` ahead of this sweep): the inbox's TAC goes straight back
            // into the confidential pool for `back`, so no one can keep it from both the chain and the way back
            CONFIDENTIAL.wrap(CONFIDENTIAL_TAC, amount * UNIT, back);
            emit Swept(box, back);
            emit Returned(amount, back);
            return;
        }
        pending[key] = Pending(box, uint40(block.timestamp), 0);
        emit Deposited(shareCount, amount, cx, cy, body, box);
        emit Swept(box, back);
    }

    /// @notice Sends a swept deposit no block has taken in within RECLAIM_AFTER back into the confidential pool, as its deposit
    ///         for `back` (the commitment the inbox's address fixed). Anyone may call it.
    function giveBack(uint256 shareCount, uint256 amount, bytes32 cx, bytes32 cy, bytes32 body, bytes32 back) external nonReentrant {
        bytes32 key = keccak256(abi.encode(TAC_ASSET, shareCount, cx, cy, body, amount));
        Pending memory p = pending[key];
        if (p.from == address(0)) revert NotPending();
        if (p.from != inbox(shareCount, amount, cx, cy, body, back)) revert NotInbox();
        if (block.timestamp < uint256(p.at) + RECLAIM_AFTER && !_stale(shareCount, amount)) revert TooSoon();
        if (p.forced > queueDone) revert DepositQueued();
        delete pending[key];
        CONFIDENTIAL.wrap(CONFIDENTIAL_TAC, amount * UNIT, back);
        emit Returned(amount, back);
    }

    /// @notice Sends a deposit no block has taken in within RECLAIM_AFTER back to whoever made it, unless an entry its
    ///         depositor queued to take it in is still ahead of the chain. Anyone may call it. (A swept deposit goes back
    ///         with `giveBack`.) One whose amount no longer buys its shares at the chain's rate goes back at once.
    function reclaim(uint256 shareCount, uint256 amount, bytes32 cx, bytes32 cy, bytes32 body) external nonReentrant {
        bytes32 key = keccak256(abi.encode(TAC_ASSET, shareCount, cx, cy, body, amount));
        Pending memory p = pending[key];
        if (p.from == address(0)) revert NotPending();
        if (p.from.codehash == INBOX_CODEHASH) revert SweptDeposit();
        if (block.timestamp < uint256(p.at) + RECLAIM_AFTER && !_stale(shareCount, amount)) revert TooSoon();
        if (p.forced > queueDone) revert DepositQueued();
        delete pending[key];
        _call(abi.encodeWithSelector(0xa9059cbb, p.from, amount * UNIT));
        emit Reclaimed(p.from, amount);
    }

    /// @dev Whether `amount` units no longer buy `shareCount` shares at the rate the last block left: every later block prices at that
    ///      rate or a higher one, so no block can take the deposit in, and it may go back at once instead of after RECLAIM_AFTER.
    function _stale(uint256 shareCount, uint256 amount) internal view returns (bool) {
        return amount * (uint256(shares) + VIRTUAL) < shareCount * (uint256(pool) + VIRTUAL);
    }

    /// @dev A deposit's key: keccak256 of the record the block program publishes for it (asset ‖ shares ‖ cx ‖ cy ‖ body ‖ amount),
    ///      checked to be one a spend could take in.
    function _depositKey(uint256 shareCount, uint256 amount, bytes32 cx, bytes32 cy, bytes32 body) internal view returns (bytes32) {
        if (shareCount == 0 || shareCount > type(uint64).max || amount == 0 || amount > type(uint64).max) revert BadValue();
        if (!_onCurve(uint256(cx), uint256(cy)) || uint256(body) >= R) revert BadCommitment();
        return keccak256(abi.encode(TAC_ASSET, shareCount, cx, cy, body, amount));
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
    ///         otherwise. A claim is posted with time to spare: the chain must reach it (FORCE_DELAY, then up to WINDOW before
    ///         anyone may land a block that does, and that block's proving) and land it TIME_WINDOW before the deadline, so a
    ///         wallet posts it at least FORCE_DELAY + WINDOW + TIME_WINDOW + a day before. A refund is posted from TIME_WINDOW
    ///         after the deadline (a block may name a time up to TIME_WINDOW before it lands).
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
            uint256 shareCount = uint64(bytes8(payload[FORCED_REST_AT + 53:FORCED_REST_AT + 61]));
            uint256 amount = uint64(bytes8(payload[FORCED_REST_AT + 93:FORCED_REST_AT + 101]));
            Pending storage p = pending[keccak256(abi.encode(asset, shareCount, bytes32(payload[320:352]), bytes32(payload[352:384]), bytes32(payload[32:64]), amount))];
            // its depositor's, or a swept one's (whose depositor has no address here: anyone may queue the one spend that takes it,
            // while the chain can still reach the entry before giveBack is due, so no one can hold a swept deposit back for good)
            if (p.from != msg.sender) {
                if (p.from == address(0) || p.from.codehash != INBOX_CODEHASH) revert NotDepositor();
                if (block.timestamp + FORCE_DELAY + WINDOW > uint256(p.at) + RECLAIM_AFTER) revert TooLate();
            }
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

    /// @notice Whether a queued entry has waited FORCE_DELAY + WINDOW without the chain reaching it: anyone may land until it does.
    function backlogged() public view returns (bool) {
        return queueDone < queued && block.timestamp >= queuedAt[queueDone] + FORCE_DELAY + WINDOW;
    }

    /// @notice Lands the next block: its proof, its nineteen public words and the lists it publishes.
    function land(bytes calldata publicValues, bytes calldata proof, Lists calldata lists) external nonReentrant {
        // the leader of the turn lands until WINDOW passes with no block, or until a queued entry has waited FORCE_DELAY + WINDOW
        // (so leaders that land only what they must cannot hold the queue back: anyone may then land a block that reaches it)
        if (block.timestamp < uint256(lastLanded) + WINDOW && !backlogged()) {
            address lead = TURNS.turn();
            if (lead != address(0) && msg.sender != lead) revert NotYourTurn();
        }
        if (publicValues.length != 32 * PUBLIC_WORDS) revert BadPublicValues();
        VERIFIER.verifyProof(BLOCK_VKEY, publicValues, proof);
        bytes32[19] memory w = abi.decode(publicValues, (bytes32[19]));
        if (w[0] != state || w[2] != noteRoot) revert NotOnTop();
        // the time the block names, by which its claims and refunds were decided
        if (block.timestamp < uint256(w[14]) || block.timestamp > uint256(w[14]) + TIME_WINDOW) revert BadTime();
        if (w[9] != SPEND_VK) revert WrongRelation();
        // how far through the queue the chain is after the block, and the queue's hash there (the program only moves
        // it on, from where the state digest says it was)
        uint256 done = uint256(w[10]);
        if (done < queueDone || done > queued || w[11] != queueHash[done]) revert BadQueue();
        if (done < queued && block.timestamp >= queuedAt[done] + FORCE_DELAY && done - queueDone < MAX_FORCED) revert QueueOverdue();

        if (w[15] == 0) {
            // the notes, nullifiers and claims are in this call's data, each list checked against the hash the proof commits
            if (lists.blobs.length != 0) revert BadList(8);
            _checkOutputs(lists.leaves, lists.memos, w[4]);
            if (_listHash(2, lists.nullifiers.length, abi.encodePacked(lists.nullifiers)) != w[5]) revert BadList(2);
            if (lists.claims.length % CLAIM_LEN != 0 || _listHash(7, lists.claims.length / CLAIM_LEN, lists.claims) != w[13]) revert BadList(7);
        } else {
            // they are in the transaction's blobs, which the program proved hold exactly them; nothing here acts on them
            if (lists.leaves.length != 0 || lists.memos.length != 0 || lists.nullifiers.length != 0 || lists.claims.length != 0) revert BadList(8);
            _checkBlobs(lists.blobs, w[15]);
        }
        if (_listHash(3, lists.anchors.length, abi.encodePacked(lists.anchors)) != w[6]) revert BadList(3);
        for (uint256 i; i < lists.anchors.length; ++i) {
            if (!knownRoot[lists.anchors[i]]) revert UnknownAnchor(lists.anchors[i]);
        }

        bytes calldata deposits = lists.deposits;
        if (deposits.length % DEPOSIT_LEN != 0) revert BadList(4);
        uint256 nDeposits = deposits.length / DEPOSIT_LEN;
        if (_listHash(4, nDeposits, deposits) != w[7]) revert BadList(4);
        uint256 worth = inChain;
        for (uint256 i; i < nDeposits; ++i) {
            bytes32 key = keccak256(deposits[DEPOSIT_LEN * i:DEPOSIT_LEN * (i + 1)]);
            worth += uint256(bytes32(deposits[DEPOSIT_LEN * i + 160:DEPOSIT_LEN * i + 192]));
            Pending storage p = pending[key];
            if (p.from == address(0)) revert NoSuchDeposit(i);
            // a queued entry for it does not hold it back: only the one spend the deposit names can take it in, once (its
            // deposit nullifier), so a block may take it before reaching the entry, which the program then passes over; that a
            // deposit is queued only keeps it from going back (reclaim, giveBack) while an entry that could take it is ahead
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
            uint256 out = uint256(bytes32(exits[EXIT_LEN * i + 32:EXIT_LEN * i + 64]));
            if (out > worth) revert Insolvent();
            worth -= out;
            owed[address(uint160(to))] += out * UNIT;
        }

        bytes calldata hopList = lists.hops;
        if (hopList.length % HOP_LEN != 0) revert BadList(6);
        uint256 nHops = hopList.length / HOP_LEN;
        if (_listHash(6, nHops, hopList) != w[12]) revert BadList(6);
        for (uint256 i; i < nHops; ++i) {
            bytes32 asset = bytes32(hopList[HOP_LEN * i:HOP_LEN * i + 32]);
            if (asset != TAC_ASSET) revert NotTac(asset);
            uint256 out = uint256(bytes32(hopList[HOP_LEN * i + 32:HOP_LEN * i + 64]));
            if (out > worth) revert Insolvent();
            worth -= out;
            hops[keccak256(hopList[HOP_LEN * i + 32:HOP_LEN * (i + 1)])] += 1;
        }
        worth = _migrate(lists.migrations, lists.migrationTotals, w[16], w[17], worth, height + 1);
        // the program's pool (the TAC behind the notes, by its own count) is the TAC this contract holds for them, by its own
        pool = uint64(uint256(w[18]) >> 64);
        shares = uint64(uint256(w[18]));
        if (uint256(w[18]) >> 128 != 0 || pool != worth) revert Insolvent();
        inChain = worth;

        state = w[1];
        noteRoot = w[3];
        knownRoot[w[3]] = true;
        queueDone = uint64(done);
        uint64 h = height + 1;
        height = h;
        lastLanded = uint64(block.timestamp);
        emit Landed(h, w[1], w[3], msg.sender);
    }

    /// @dev A block's migrations: the lists checked against the words the proof committed, the hash of the moves kept for successors,
    ///      and each successor's total sent to it (an address the program allows: twenty bytes, not zero; one that is this contract
    ///      or cannot use TAC leaves it where it lands, which only its own movers chose). → what the chain's notes are then worth.
    function _migrate(bytes calldata moves, bytes calldata totals, bytes32 movesHash, bytes32 totalsHash, uint256 worth, uint256 h)
        internal
        returns (uint256)
    {
        if (moves.length % MIGRATION_LEN != 0 || _listHash(8, moves.length / MIGRATION_LEN, moves) != movesHash) revert BadList(9);
        if (totals.length % MIGRATION_TOTAL_LEN != 0) revert BadList(10);
        uint256 n = totals.length / MIGRATION_TOTAL_LEN;
        if (_listHash(9, n, totals) != totalsHash) revert BadList(10);
        if (moves.length != 0) migrationsOf[h] = movesHash;
        for (uint256 i; i < n; ++i) {
            address to = address(uint160(uint256(bytes32(totals[MIGRATION_TOTAL_LEN * i:MIGRATION_TOTAL_LEN * i + 32]))));
            uint256 out = uint256(bytes32(totals[MIGRATION_TOTAL_LEN * i + 32:MIGRATION_TOTAL_LEN * (i + 1)]));
            if (out > worth) revert Insolvent();
            worth -= out;
            migrated[h][to] = out;
            _call(abi.encodeWithSelector(0xa9059cbb, to, out * UNIT));
            emit Migrated(h, to, out);
        }
        return worth;
    }

    /// @notice Sends `to` the TAC exits have credited it. Anyone may call it.
    ///         Not to this contract, the token or a deposit's inbox, which could never pass it on: what an exit credits them stays.
    function withdraw(address to) external nonReentrant {
        if (to == address(this) || to == TAC || to.codehash == INBOX_CODEHASH) revert BadAddress(0);
        uint256 amount = owed[to];
        owed[to] = 0;
        _call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        emit Withdrawn(to, amount);
    }

    /// @notice Sends a landed hop of `value` units into the confidential pool, as its deposit for `commit` (the pool burns the
    ///         TAC from this contract and records the deposit; the note it names is made there when it is wrapped in). Anyone
    ///         may call it.
    function sendHop(uint256 value, bytes32 commit) external nonReentrant {
        if (!_sendHop(value, commit)) revert HopNotTaken();
    }

    /// @notice Sends several landed hops on in one transaction; one the confidential pool refuses stays, and the rest go on.
    function sendHops(uint256[] calldata values, bytes32[] calldata commits) external nonReentrant {
        if (values.length != commits.length) revert NoSuchHop();
        for (uint256 i; i < values.length; ++i) {
            _sendHop(values[i], commits[i]);
        }
    }

    /// @dev False, with the hop kept, when the pool refuses the deposit: it takes a commitment once, so one wrapped there by anyone
    ///      first (or a second hop to the same commitment) is refused. The note that deposit names is made all the same, from the
    ///      other one, so the hop's owner loses nothing; what the refused hop held stays with this contract.
    function _sendHop(uint256 value, bytes32 commit) internal returns (bool) {
        bytes32 key = keccak256(abi.encode(value, commit));
        if (hops[key] == 0) revert NoSuchHop();
        hops[key] -= 1;
        try CONFIDENTIAL.wrap(CONFIDENTIAL_TAC, value * UNIT, commit) {
            emit Hopped(value, commit);
            return true;
        } catch {
            hops[key] += 1;
            emit HopRefused(value, commit);
            return false;
        }
    }

    /// @dev A block whose lists are in blobs: each blob's versioned hash is the transaction's, and its commitment opens to the value the
    ///      program computed at the point it drew (the point-evaluation precompile); the program committed SHA-256 of every (versioned
    ///      hash, point, value), so the blobs hold exactly the data the block's lists are made of.
    function _checkBlobs(bytes calldata data, bytes32 want) internal view {
        if (data.length == 0 || data.length % BLOB_OPENING_LEN != 0) revert BadList(8);
        uint256 n = data.length / BLOB_OPENING_LEN;
        bytes memory items = new bytes(96 * n);
        for (uint256 i; i < n; ++i) {
            bytes calldata o = data[BLOB_OPENING_LEN * i:BLOB_OPENING_LEN * (i + 1)];
            // EIP-4844's versioned hash: 0x01 ‖ SHA-256(commitment)[1:]
            bytes32 vh = bytes32((uint256(sha256(o[0:48])) & (type(uint256).max >> 8)) | (uint256(1) << 248));
            if (blobhash(i) != vh) revert BadBlob(i);
            (bool ok, bytes memory ret) = POINT_EVALUATION.staticcall(abi.encodePacked(vh, o[48:80], o[80:112], o[0:48], o[112:160]));
            if (!ok || ret.length != 64) revert BadBlob(i);
            bytes32 z = bytes32(o[48:80]);
            bytes32 y = bytes32(o[80:112]);
            assembly {
                let at := add(add(items, 32), mul(96, i))
                mstore(at, vh)
                mstore(add(at, 32), z)
                mstore(add(at, 64), y)
            }
        }
        if (sha256(items) != want) revert BadList(8);
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
