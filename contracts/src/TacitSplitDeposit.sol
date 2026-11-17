// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// The fixed-denomination pools' deposit (Tornado Cash's ETH pools): the commitment is the caller's, the ETH sent is the pool's size.
interface IFixedPool {
    function deposit(bytes32 commitment) external payable;
    function denomination() external view returns (uint256);
}

/// The Tacit pool's one call. A deposit into the ETH pool is `extAmount > 0` and the same ETH sent; its proof is the caller's own.
interface ITacitEthPool {
    function ASSET() external view returns (address);
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
    ) external payable;
}

/// @title TacitSplitDeposit
/// @notice A large deposit in one transaction: whole notes into the fixed-denomination pools and the rest into the Tacit ETH pool, all
///         or nothing. A wallet that cannot send calls together (most can't) still signs once, and a deposit that stops half way
///         (a note placed, the rest refused) cannot happen: if any call fails the whole transaction reverts.
///
///         The caller names which pools and what commitments, and brings the Tacit deposit as its own proof (the same `Tx` the
///         pool takes). This contract chooses nothing: it is told, checks, and passes on.
///           - A note goes only to a pool fixed in the constructor, for exactly that pool's size.
///           - The Tacit part is the pool's own deposit call with `extAmount` ETH. `extAmount == 0` means notes only (the proof is then
///             not read), and a withdrawal (`extAmount < 0`) is refused here.
///           - `msg.value` must equal the notes' sizes plus `extAmount` to the wei, so nothing is left to keep, refund or take.
///
/// Trust model: no owner, no setter, no upgrade, no token handling, no receive, no events (the pools' own say it all). It keeps
/// nothing of anyone's: the exact-value check leaves no balance of its own, a bare transfer to it reverts, and nothing it does reads
/// its balance (ETH forced in by a selfdestruct, or paid to it as the relayer fee of a proof that names it, is simply stuck). The
/// commitments are the caller's and the Tacit proof binds its own recipient and amount, so the forwarder cannot redirect a note or the
/// deposit. A pool's revert is passed up unchanged, so a caller reading the revert data (a stale Tacit proof, a commitment already
/// used) sees the pool's own error.
///
/// The Tacit deposit goes first: the likeliest failure is a stale proof (another deposit landed between proving and inclusion), and
/// the pool refuses it in its first few lines, so that revert costs a few tens of thousands of gas and not the notes' million or two.
///
/// Not for tokens: it takes none, and tokens sent to it are stuck (zRouter's `snwap`, for one, moves its `tokenIn` to its executor).
/// It does not look at `msg.sender`, so another contract can call it with ETH. Re-entry gains nothing: the Tacit pool pays a relayer
/// named in the caller's own proof with up to 100,000 gas (`forceSafeTransferETH`), enough to call back in, but each call is checked
/// against its own `msg.value` and there is no state to corrupt, so a re-entering call can only spend what it sends.
contract TacitSplitDeposit {
    /// The Tacit pool's `transact` arguments as one struct (the same layout as TacitEvmPoolRouter.Tx, so the same encoding builds it).
    struct Tx {
        uint256[2] pA;
        uint256[2][2] pB;
        uint256[2] pC;
        uint256[11] publicInputs;
        address recipient;
        int256 extAmount;
        address relayer;
        uint256 fee;
        bytes memo0;
        bytes memo1;
    }

    /// The Tacit ETH pool the rest goes into.
    ITacitEthPool public immutable TACIT_POOL;
    /// The pools a note can go to, and each one's size in wei (0 = not a pool of this contract).
    mapping(address pool => uint256) public denominationOf;

    /// At most this many notes in one call (a deposit into a fixed pool costs about 0.8 to 1 million gas).
    uint256 public constant MAX_NOTES = 16;

    error NotAPool();
    error LengthMismatch();
    error TooManyNotes();
    error NothingToDeposit();
    error NotADeposit();
    error WrongValue(uint256 sent, uint256 expected);
    error NoPools();
    error NotAnEthPool();
    error BadSize();
    error RepeatedPool();

    /// @param tacitPool the Tacit pool for ETH (its `ASSET()` is the zero address).
    /// @param pools the fixed-denomination pools a note can go to; each is read for its size now and must give one.
    constructor(address tacitPool, address[] memory pools) {
        if (tacitPool.code.length == 0 || ITacitEthPool(tacitPool).ASSET() != address(0)) revert NotAnEthPool();
        if (pools.length == 0) revert NoPools();
        TACIT_POOL = ITacitEthPool(tacitPool);
        for (uint256 i; i < pools.length; ++i) {
            uint256 d = IFixedPool(pools[i]).denomination();
            if (d == 0) revert BadSize();
            if (denominationOf[pools[i]] != 0) revert RepeatedPool();
            denominationOf[pools[i]] = d;
        }
    }

    /// @notice Deposit `commitments[i]` into `pools[i]` (one note each, a pool may repeat) and `t.extAmount` into the Tacit pool.
    ///         `t` is the Tacit pool's own deposit, proved by the caller; with `t.extAmount == 0` it is not used and only notes go in.
    function splitDeposit(address[] calldata pools, bytes32[] calldata commitments, Tx calldata t) external payable {
        uint256 n = pools.length;
        if (n != commitments.length) revert LengthMismatch();
        if (n > MAX_NOTES) revert TooManyNotes();
        if (t.extAmount < 0) revert NotADeposit();
        uint256 tacit = uint256(t.extAmount);
        uint256 notes;
        for (uint256 i; i < n; ++i) {
            uint256 d = denominationOf[pools[i]];
            if (d == 0) revert NotAPool();
            notes += d;
        }
        if (n == 0 && tacit == 0) revert NothingToDeposit();
        if (msg.value != notes + tacit) revert WrongValue(msg.value, notes + tacit);

        if (tacit != 0) {
            TACIT_POOL.transact{value: tacit}(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
        }
        for (uint256 i; i < n; ++i) IFixedPool(pools[i]).deposit{value: denominationOf[pools[i]]}(commitments[i]);
    }
}
