// SPDX-License-Identifier: MIT
pragma solidity 0.8.37;

/// The fixed-denomination pools' deposit (Tornado Cash's ETH pools): the commitment is the caller's, the ETH sent is the pool's size.
interface IFixedPool {
    function deposit(bytes32 commitment) external payable;
    function denomination() external view returns (uint256);
}

/// The Tacit ETH pool's one call. A deposit is `extAmount > 0` and the same ETH sent; its proof is the caller's own.
interface ITacitEthPool {
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

/// The Tacit pool's `transact` arguments as one struct (the same layout as TacitEvmPoolRouter.Tx, so the same encoding builds it).
struct TacitTx {
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

/// @title TacitSplitDeposit
/// @notice A large deposit in one transaction: whole notes into the fixed-denomination pools and the rest into the Tacit ETH pool, all
///         or nothing. A wallet that cannot send calls together (most can't) still signs once, and a deposit that stops half way
///         (a note placed, the rest refused) cannot happen: if any call fails the whole transaction reverts.
///
///         The caller names which pools and what commitments, and brings the Tacit deposit as its own proof (the same `Tx` the
///         pool takes). This contract chooses nothing: it is told, checks, and passes on.
///           - A note goes only to a pool fixed in the constructor, for exactly that pool's size.
///           - The Tacit part is the pool's own deposit call with `extAmount` ETH. A withdrawal (`extAmount < 0`) is refused here.
///           - `msg.value` must equal the notes' sizes plus `extAmount` to the wei, so nothing is left to keep, refund or take.
///
/// Trust model: no owner, no setter, no upgrade, no token handling, no receive. Holds nothing between transactions (the exact-value
/// check leaves no balance, and a bare transfer to it reverts). The commitments are the caller's and the Tacit proof binds its
/// own recipient and amount, so the forwarder cannot redirect a note or the deposit. A pool's revert is passed up unchanged, so a
/// caller reading the revert data (a stale Tacit proof, a commitment already used) sees the pool's own error.
///
/// It does not look at `msg.sender`, so it can also be run as the executor of zRouter's `snwap` (a payer of any token whose swap
/// leaves this contract the ETH), or called by another contract. Re-entry is not reachable: the pools make no call to the sender
/// on a deposit.
contract TacitSplitDeposit {
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
    error BadPools();

    event SplitDeposit(address indexed sender, uint256 notes, uint256 noteValue, uint256 tacitValue);

    /// @param tacitPool the Tacit ETH pool.
    /// @param pools the fixed-denomination pools a note can go to; each is read for its size now and must give a size.
    constructor(address tacitPool, address[] memory pools) {
        if (tacitPool.code.length == 0 || pools.length == 0) revert BadPools();
        TACIT_POOL = ITacitEthPool(tacitPool);
        for (uint256 i; i < pools.length; ++i) {
            uint256 d = IFixedPool(pools[i]).denomination();
            if (d == 0 || denominationOf[pools[i]] != 0) revert BadPools();
            denominationOf[pools[i]] = d;
        }
    }

    /// @notice Deposit `commitments[i]` into `pools[i]` (one note each, a pool may repeat) and `t.extAmount` into the Tacit pool.
    ///         `t` is the Tacit pool's own deposit, proved by the caller; with `t.extAmount == 0` it is not used and only notes go in.
    function splitDeposit(address[] calldata pools, bytes32[] calldata commitments, TacitTx calldata t) external payable {
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

        for (uint256 i; i < n; ++i) IFixedPool(pools[i]).deposit{value: denominationOf[pools[i]]}(commitments[i]);
        if (tacit != 0) {
            TACIT_POOL.transact{value: tacit}(t.pA, t.pB, t.pC, t.publicInputs, t.recipient, t.extAmount, t.relayer, t.fee, t.memo0, t.memo1);
        }
        emit SplitDeposit(msg.sender, n, notes, tacit);
    }
}
