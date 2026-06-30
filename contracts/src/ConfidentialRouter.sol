// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ReentrancyGuardTransient} from "solady/utils/ReentrancyGuardTransient.sol";
import {SafeTransferLib} from "solady/utils/SafeTransferLib.sol";

interface IConfidentialPool {
    function wrap(bytes32 assetId, uint256 amount, bytes32 commit) external payable;
    function settle(bytes calldata publicValues, bytes calldata proofBytes, bytes[] calldata memos) external;
    function canonicalTokenFor(bytes32 assetId) external view returns (address);
    function localAssetOf(bytes32 assetId) external view returns (bytes32);
    function assets(bytes32 assetId)
        external
        view
        returns (
            bool registered,
            address underlying,
            uint256 unitScale,
            bytes32 crossChainLink,
            bool poolMinted,
            uint8 decimals
        );
    function pools(bytes32 poolId)
        external
        view
        returns (
            bool init,
            bytes32 assetA,
            bytes32 assetB,
            uint256 reserveA,
            uint256 reserveB,
            uint32 feeBps,
            uint256 totalShares
        );
    function swapPublic(
        bytes32 assetIn,
        bytes32 assetOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to
    ) external payable returns (uint256 amountOut);
    function createPairAndAddLiquidityPublic(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint256 amountA,
        uint256 amountB,
        uint256 minSharesOut,
        uint64 deadline,
        address to
    ) external payable returns (uint256 sharesMinted);
    function removeLiquidityPublicFrom(
        bytes32 assetA,
        bytes32 assetB,
        uint32 feeBps,
        uint256 shares,
        uint256 minAmountA,
        uint256 minAmountB,
        uint64 deadline,
        address owner,
        address to
    ) external returns (uint256 amountLo, uint256 amountHi);
    function shieldShares(bytes32 poolId, uint256 shares, bytes32 commit) external returns (bytes32 depositId);
}

/// EIP-2612 permit (USDC and most modern ERC20s; DAI's non-standard permit is NOT this shape — those go
/// through Permit2 instead).
interface IERC2612 {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}

/// Uniswap Permit2 (AllowanceTransfer) — the canonical singleton at
/// 0x000000000022D473030F116dDEE9F6B43aC78BA3 on every chain. After a ONE-TIME `token.approve(PERMIT2, max)`,
/// every later approval is a signature, for ANY ERC20 (permit-native or not).
interface IPermit2 {
    struct PermitDetails {
        address token;
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    struct PermitSingle {
        PermitDetails details;
        address spender;
        uint256 sigDeadline;
    }

    struct PermitBatch {
        PermitDetails[] details;
        address spender;
        uint256 sigDeadline;
    }

    function permit(address owner, PermitSingle calldata permitSingle, bytes calldata signature) external;
    function permit(address owner, PermitBatch calldata permitBatch, bytes calldata signature) external;
    function transferFrom(address from, address to, uint160 amount, address token) external;
}

interface IERC20Allowance {
    function allowance(address owner, address spender) external view returns (uint256);
}

/// @title ConfidentialRouter
/// @notice One periphery router for ConfidentialPool, collapsing each common flow into a single transaction
///         with a signature-based approval (EIP-2612 / Permit2 / native msg.value). It spans five families:
///
///           1. ON-RAMP (wrap*) — public→confidential deposit for `commit` (a later settle inserts the leaf
///              + memo). EIP-2612, Permit2, or native ETH.
///           2. PRIVATE PAYMENT (wrapAndSettle* / zapETHToPayment) — wrap to a recipient-owned `commit`, then
///              settle a self-proved batch that consumes the deposit, inserts the recipient's note leaf, and
///              emits the recipient's ECDH memo (the discovery channel). Sender + amount are public; only the
///              RECIPIENT is hidden (`commit` binds the note's owner, not msg.sender).
///           3. PUBLIC AMM (swapPublic* / addLiquidityPublic*) — gasless-approve transparent-lane swap / LP add.
///           4. ZAPS (zap*) — source liquidity from the pinned external aggregator (zRouter) and land it in the
///              confidential pool: cold-start a public LP, shield an LP position into a note, bond it into a
///              farm, or swap-and-wrap any asset into a confidential note / private payment.
///           5. EXTERNAL AMM (swap*ViaZRouter*) — user-directed zRouter swaps with router-held output
///              balance-delta checks, for routes that should stay outside the confidential pool.
///
///  Trust model. The router takes the user's tokens only TRANSIENTLY within a call — it pulls them via the
///  signed approval (or msg.value), hands them to `wrap`/`swapPublic`/`createPair…`/zRouter, and sweeps each
///  NAMED leg (plus the pool's off-ratio refund) back to the caller, so a well-formed call leaves no resting
///  balance. The router is strictly NON-CUSTODIAL: any stray residue — a multi-hop swap's non-named dust, a
///  direct transfer — is not owner-attributed, so the next caller's refund sweeps it; never leave value
///  resting here. Its only standing state is a lazy (infinite) allowance to the immutable, PINNED targets —
///  the POOL and zRouter — safe because those targets are trusted and a well-formed call holds nothing for
///  them to pull beyond what the caller supplied. Both external targets are immutable: the POOL
///  and zRouter addresses are never arbitrary; only the swap SELECTION within zRouter (`zrSwapData`, routed
///  across V2/V3/V4/Curve/zAMM) is the caller's. The note stays the user's: `commit` is forwarded verbatim,
///  the router never sees note secrets, and a malicious/buggy call can at worst revert (atomic) — it cannot
///  redirect or retain funds. A hostile `zrSwapData` yields too little output, the downstream slippage gate
///  (`minShares` / `minAmountOut` / the wrap value binding) reverts, and the whole tx unwinds — fail-closed.
///  nonReentrant on every entrypoint. Settles run with msg.sender == this router, so the private-payment /
///  bond flows MUST be self-proved with NO settler fees (`pv.fees` empty) — fee-free by construction.
///
///  Consolidated (vs a separate wrap + zap router) so a user grants ONE Permit2 allowance that covers every
///  flow, and the shared permit / lazy-approve / asset-id / refund machinery lives once.
///
///  Why periphery, not the pool: ConfidentialPool is immutable + codesize-bound, and permit standards vary
///  (EIP-2612 / DAI-style / Permit2). Keeping this here lets it support every flavor and be replaced as
///  standards evolve, without bloating the value-custody core. The pool needs no change — `wrap` pulls from
///  `msg.sender` and binds the note via `commit`, `settle` is permissionless, and the public-AMM entrypoints
///  credit a caller-chosen `to`.
contract ConfidentialRouter is ReentrancyGuardTransient {
    IConfidentialPool public immutable POOL;
    IPermit2 public immutable PERMIT2;
    /// zRouter — the pinned external AMM aggregator (0x000000000000FB114709235f1ccBFfb925F600e4). Low-level
    /// called with caller-built swap calldata so any zRouter venue (V2/V3/V4/Curve/zAMM) works without this
    /// router hardcoding one; the address is immutable, so the target is never arbitrary.
    address public immutable ZROUTER;

    error AmountTooLarge();
    error BadPath();
    error BadPermit2();
    error BadProofIntent();
    error BadTarget();
    error MaxAmountExceeded();
    error ZRouterCallFailed();

    /// Parameters for a token-in zap (bundled to keep the entrypoints under the stack limit).
    struct TokenZap {
        address tokenB; // the leg sourced from zRouter (paired with the input token A)
        uint32 feeBps;
        uint256 tokenAForSwap; // token A routed through zRouter for tokenB
        uint256 tokenAForLP; // token A for the LP leg
        uint256 tokenBLeg; // exact tokenB for the LP leg (the swap must source at least this)
        uint256 minShares;
        uint64 deadline;
        bytes32 commit; // recipient's LP-share note commitment
    }

    constructor(address pool_, address zRouter_, address permit2_) {
        if (
            pool_ == address(0) || pool_.code.length == 0 || permit2_ == address(0) || permit2_.code.length == 0
                || (zRouter_ != address(0) && zRouter_.code.length == 0)
        ) {
            revert BadTarget();
        }
        POOL = IConfidentialPool(pool_);
        ZROUTER = zRouter_;
        PERMIT2 = IPermit2(permit2_);
    }

    // ──────────────────── One-tx on-ramp (wrap only) ────────────────────

    /// @notice One-tx wrap of an EIP-2612 token (e.g. USDC): the user signs an allowance to THIS router and
    ///         the router pulls `amount` and wraps it to `commit`. `permit` is best-effort (try/catch) so a
    ///         front-runner replaying the same permit can't grief the wrap by pre-consuming the nonce — the
    ///         `safeTransferFrom` below still enforces the allowance.
    /// @param token  the underlying ERC20 (already registered in the pool via registerWrapped/Auto).
    /// @param amount underlying amount to escrow (must be a multiple of the asset's unitScale, per the pool).
    /// @param commit the note commitment keccak(Cx‖Cy‖owner) — identical to a direct `wrap`; binds the note
    ///        (and, for a payment, the recipient). The caller computes it; the router only forwards it.
    function wrapWithPermit(
        address token,
        uint256 amount,
        bytes32 commit,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant {
        _wrap2612(token, amount, commit, deadline, v, r, s);
    }

    /// @notice One-tx wrap via Permit2 (works for ANY ERC20 after a one-time `token.approve(PERMIT2, max)`).
    function wrapWithPermit2(
        address token,
        uint256 amount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant {
        _wrapPermit2(token, amount, commit, permitSingle, signature);
    }

    // ──────────────────── One-tx private payment (wrap + self-proved settle) ────────────────────

    /// @notice One-tx private payment with an EIP-2612 token: wrap `amount` to a recipient-owned `commit`,
    ///         then settle a SELF-PROVED batch that consumes the deposit, inserts the recipient's note leaf,
    ///         and emits the recipient's encrypted memo (via the pool's LeavesInserted). The caller builds
    ///         `publicValues`/`proof`/`memos` off-chain (the proof binds the deposit's value to the leaf).
    /// @dev    The settle runs with msg.sender == this router, so it MUST be a self-proved batch with NO
    ///         settler fees (`pv.fees` empty). A fee in `token` is swept back to the caller below; a fee in
    ///         any other asset would strand (non-custodial residue) — so build fee-free.
    function wrapAndSettleWithPermit(
        address token,
        uint256 amount,
        bytes32 commit,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant {
        _wrap2612(token, amount, commit, deadline, v, r, s);
        _relaySettle(publicValues, proof, memos);
        _refund(token, msg.sender); // sweep a (mis-built) settle fee paid in `token` back to the caller
    }

    /// @notice One-tx private payment via Permit2 (any ERC20). See `wrapAndSettleWithPermit` for the
    ///         self-proved / fee-free settle constraint.
    function wrapAndSettleWithPermit2(
        address token,
        uint256 amount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant {
        _wrapPermit2(token, amount, commit, permitSingle, signature);
        _relaySettle(publicValues, proof, memos);
        _refund(token, msg.sender); // sweep a (mis-built) settle fee paid in `token` back to the caller
    }

    // ──────────────────── Native ETH (no permit — msg.value IS the approval) ────────────────────

    /// @notice One-tx on-ramp of native ETH into a confidential deposit: send `msg.value` and the router
    ///         wraps it to `commit` as the pinned native-ETH (tETH) asset. No permit/approval needed — ETH
    ///         is carried by the call. A later settle inserts the leaf + memo. (Reverts if this generation
    ///         didn't register native ETH, i.e. tETH isn't a pool asset.)
    function wrapETH(bytes32 commit) external payable nonReentrant {
        _wrapETH(msg.value, commit);
    }

    /// @notice One-tx native-ETH private payment — the ETH analog of `wrapAndSettleWithPermit`: wrap
    ///         `msg.value` to a recipient-owned `commit`, then settle the self-proved batch that consumes the
    ///         deposit, inserts the recipient's leaf, and emits the recipient's memo. Same self-proved /
    ///         fee-free settle constraint (the settle runs with msg.sender == this router).
    function wrapAndSettleETH(bytes32 commit, bytes calldata publicValues, bytes calldata proof, bytes[] calldata memos)
        external
        payable
        nonReentrant
    {
        _wrapETH(msg.value, commit);
        _relaySettle(publicValues, proof, memos);
        _refundETH(msg.sender); // sweep a (mis-built) settle fee paid in native ETH back to the caller
    }

    // ──────────────────── One-tx CDP open (wrap collateral + mint cUSD proof) ────────────────────

    /// @notice One-tx CDP open with EIP-2612 collateral. The proof MUST consume the wrapped collateral
    ///         deposit and carry OP_CDP_MINT outputs (cUSD debt note + position leaf) under the configured
    ///         controller. This is a named UX entrypoint over the same trust boundary as `wrapAndSettle*`.
    function wrapAndMintCusdWithPermit(
        address token,
        uint256 amount,
        bytes32 commit,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant {
        _requireCdpMintIntent(publicValues);
        _wrap2612(token, amount, commit, deadline, v, r, s);
        _relaySettle(publicValues, proof, memos);
        _refund(token, msg.sender);
    }

    /// @notice One-tx CDP open via Permit2 collateral. See `wrapAndMintCusdWithPermit`.
    function wrapAndMintCusdWithPermit2(
        address token,
        uint256 amount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant {
        _requireCdpMintIntent(publicValues);
        _wrapPermit2(token, amount, commit, permitSingle, signature);
        _relaySettle(publicValues, proof, memos);
        _refund(token, msg.sender);
    }

    /// @notice One-tx CDP open with native ETH collateral. See `wrapAndMintCusdWithPermit`.
    function wrapETHAndMintCusd(
        bytes32 commit,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable nonReentrant {
        _requireCdpMintIntent(publicValues);
        _wrapETH(msg.value, commit);
        _relaySettle(publicValues, proof, memos);
        _refundETH(msg.sender);
    }

    // ──────────────────── Public AMM swap (gasless approve) ────────────────────

    /// @notice One-tx PUBLIC swap with a gasless approval (EIP-2612): pull `amountIn` of `tokenIn`, swap it
    ///         against the pool's public reserves, and send the output straight to `to`. The amount is public
    ///         (this is the transparent lane; for a hidden-amount swap use the confidential OP_SWAP). The pool
    ///         enforces slippage (`minAmountOut`, in the output's underlying) + `deadline`; `deadline` doubles
    ///         as the permit-signature expiry. Caller passes token ADDRESSES; the router derives the asset ids.
    function swapPublicWithPermit(
        address tokenIn,
        address tokenOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external nonReentrant returns (uint256 amountOut) {
        _pull2612(tokenIn, amountIn, deadline, v, r, s);
        amountOut =
            POOL.swapPublic(_evmAssetId(tokenIn), _evmAssetId(tokenOut), feeBps, amountIn, minAmountOut, deadline, to);
    }

    /// @notice One-tx PUBLIC swap via Permit2 (any ERC20 after a one-time `token.approve(PERMIT2, max)`).
    function swapPublicWithPermit2(
        address tokenIn,
        address tokenOut,
        uint32 feeBps,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amountOut) {
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        amountOut =
            POOL.swapPublic(_evmAssetId(tokenIn), _evmAssetId(tokenOut), feeBps, amountIn, minAmountOut, deadline, to);
    }

    /// @notice PUBLIC pool swap with native ETH as input (tETH leg). Send `msg.value`; output goes directly
    ///         to `to`. This is the ETH analog of `swapPublicWithPermit*` and keeps native AMM routing
    ///         one-tx without wrapping first.
    function swapPublicETH(address tokenOut, uint32 feeBps, uint256 minAmountOut, uint64 deadline, address to)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        amountOut = POOL.swapPublic{value: msg.value}(
            _evmAssetId(address(0)), _evmAssetId(tokenOut), feeBps, msg.value, minAmountOut, deadline, to
        );
    }

    /// @notice Multi-hop PUBLIC pool swap via Permit2. `path[i]` is the output token of hop i and `fees[i]`
    ///         is that hop's fee tier; input token is the Permit2 token. Intermediate outputs are held only
    ///         long enough to feed the next pool hop, and the final output goes directly to `to`.
    function swapPublicPathWithPermit2(
        address[] calldata path,
        uint32[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amountOut) {
        _checkPath(path, fees, to);
        address tokenIn = permitSingle.details.token;
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        amountOut = _swapPublicPath(tokenIn, path, fees, amountIn, minAmountOut, deadline, to);

        _refund(tokenIn, msg.sender);
        for (uint256 i; i < path.length; ++i) {
            _refund(path[i], msg.sender);
        }
    }

    /// @notice Multi-hop PUBLIC pool swap with native ETH as the first asset. Each `path` token must be an
    ///         ERC20 output; native ETH is supported as input only, which keeps intermediate routing simple.
    function swapPublicETHPath(
        address[] calldata path,
        uint32[] calldata fees,
        uint256 minAmountOut,
        uint64 deadline,
        address to
    ) external payable nonReentrant returns (uint256 amountOut) {
        _checkPath(path, fees, to);
        amountOut = _swapPublicETHPath(path, fees, msg.value, minAmountOut, deadline, to);

        for (uint256 i; i < path.length; ++i) {
            _refund(path[i], msg.sender);
        }
        _refundETH(msg.sender);
    }

    /// @notice PUBLIC exact-output helper via Permit2. The pool is exact-input, so the router derives the
    ///         required input from live reserves, pulls ONLY that amount, and executes with
    ///         `minAmountOut = amountOut`. If reserves cannot satisfy `amountOut` within `maxAmountIn`, revert.
    function swapPublicExactOutWithPermit2(
        address tokenOut,
        uint32 feeBps,
        uint256 amountOut,
        uint256 maxAmountIn,
        uint64 deadline,
        address to,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amountIn, uint256 amountOutActual) {
        address tokenIn = permitSingle.details.token;
        bytes32 assetIn = _evmAssetId(tokenIn);
        bytes32 assetOut = _evmAssetId(tokenOut);
        amountIn = _publicAmountInForExactOut(assetIn, assetOut, feeBps, amountOut);
        if (amountIn > maxAmountIn) revert MaxAmountExceeded();
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        amountOutActual = POOL.swapPublic(assetIn, assetOut, feeBps, amountIn, amountOut, deadline, to);
        _refund(tokenIn, msg.sender);
    }

    /// @notice Native ETH analog of `swapPublicExactOutWithPermit2`: send up to `msg.value`; only the live
    ///         reserve-derived input is forwarded to the pool and the rest is refunded.
    function swapPublicETHExactOut(address tokenOut, uint32 feeBps, uint256 amountOut, uint64 deadline, address to)
        external
        payable
        nonReentrant
        returns (uint256 amountIn, uint256 amountOutActual)
    {
        bytes32 ethId = _evmAssetId(address(0));
        bytes32 outId = _evmAssetId(tokenOut);
        amountIn = _publicAmountInForExactOut(ethId, outId, feeBps, amountOut);
        if (amountIn > msg.value) revert MaxAmountExceeded();
        amountOutActual = POOL.swapPublic{value: amountIn}(ethId, outId, feeBps, amountIn, amountOut, deadline, to);
        _refundETH(msg.sender);
    }

    /// @notice Multi-hop exact-output helper via Permit2. Computes the required first-hop input by walking the
    ///         path backwards over live reserves, pulls only that amount, then executes the exact-input path.
    function swapPublicPathExactOutWithPermit2(
        address[] calldata path,
        uint32[] calldata fees,
        uint256 amountOut,
        uint256 maxAmountIn,
        uint64 deadline,
        address to,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external nonReentrant returns (uint256 amountIn, uint256 amountOutActual) {
        _checkPath(path, fees, to);
        address tokenIn = permitSingle.details.token;
        amountIn = _publicPathAmountInForExactOut(tokenIn, path, fees, amountOut);
        if (amountIn > maxAmountIn) revert MaxAmountExceeded();
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        amountOutActual = _swapPublicPath(tokenIn, path, fees, amountIn, amountOut, deadline, to);
        _refund(tokenIn, msg.sender);
        for (uint256 i; i < path.length; ++i) {
            _refund(path[i], msg.sender);
        }
    }

    /// @notice Native ETH first-hop exact-output helper for public AMM paths. Refunds `msg.value - amountIn`.
    function swapPublicETHPathExactOut(
        address[] calldata path,
        uint32[] calldata fees,
        uint256 amountOut,
        uint64 deadline,
        address to
    ) external payable nonReentrant returns (uint256 amountIn, uint256 amountOutActual) {
        _checkPath(path, fees, to);
        amountIn = _publicETHPathAmountInForExactOut(path, fees, amountOut);
        if (amountIn > msg.value) revert MaxAmountExceeded();
        amountOutActual = _swapPublicETHPath(path, fees, amountIn, amountOut, deadline, to);
        for (uint256 i; i < path.length; ++i) {
            _refund(path[i], msg.sender);
        }
        _refundETH(msg.sender);
    }

    // ──────────────────── External zRouter swaps (plain AMM routing) ────────────────────

    /// @notice Swap native ETH through the pinned zRouter and send the ERC20 output to `to`. `zrSwapData`
    ///         must direct zRouter output to THIS router; this function transfers only the observed balance
    ///         delta and reverts if it is below `minAmountOut`.
    function swapETHViaZRouter(address tokenOut, uint256 minAmountOut, address to, bytes calldata zrSwapData)
        external
        payable
        nonReentrant
        returns (uint256 amountOut)
    {
        if (tokenOut == address(0) || to == address(0)) revert BadTarget();
        uint256 beforeOut = SafeTransferLib.balanceOf(tokenOut, address(this));
        _callZRouter(msg.value, zrSwapData);
        amountOut = SafeTransferLib.balanceOf(tokenOut, address(this)) - beforeOut;
        require(amountOut >= minAmountOut, "zap: short swap output");
        SafeTransferLib.safeTransfer(tokenOut, to, amountOut);
        _refund(tokenOut, msg.sender); // sweep any pre-existing residue; the fresh delta went to `to`
        _refundETH(msg.sender);
    }

    /// @notice Swap an ERC20 through the pinned zRouter using Permit2. `zrSwapData` must spend at most
    ///         `amountIn` from this router and send the ERC20 output to THIS router.
    function swapTokenViaZRouterWithPermit2(
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address to,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData
    ) external nonReentrant returns (uint256 amountOut) {
        if (tokenOut == address(0) || to == address(0)) revert BadTarget();
        address tokenIn = permitSingle.details.token;
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        _lazyApprove(tokenIn, ZROUTER, amountIn);
        uint256 beforeOut = SafeTransferLib.balanceOf(tokenOut, address(this));
        _callZRouter(0, zrSwapData);
        amountOut = SafeTransferLib.balanceOf(tokenOut, address(this)) - beforeOut;
        require(amountOut >= minAmountOut, "zap: short swap output");
        SafeTransferLib.safeTransfer(tokenOut, to, amountOut);
        _refund(tokenIn, msg.sender);
        _refund(tokenOut, msg.sender); // sweep any pre-existing residue; the fresh delta went to `to`
    }

    // ──────────────────── Public AMM liquidity (gasless approve) ────────────────────

    /// @notice One-tx PUBLIC liquidity add via a Permit2 batch (ONE signature for BOTH tokens): pull
    ///         `amountA` of `tokenA` + `amountB` of `tokenB`, lazily create the (canonical) pool if it
    ///         doesn't exist, add liquidity, and credit the LP shares to `to`. The off-ratio excess the pool
    ///         refunds (to msg.sender == this router) is forwarded back to the caller, so the router keeps no
    ///         balance. ERC20-only — a native-ETH leg would need a payable variant. `feeBps`/`minSharesOut`/
    ///         `deadline` are the pool's; caller passes token ADDRESSES (the router derives the asset ids).
    function addLiquidityPublicWithPermit2(
        address tokenA,
        address tokenB,
        uint32 feeBps,
        uint256 amountA,
        uint256 amountB,
        uint256 minSharesOut,
        uint64 deadline,
        address to,
        IPermit2.PermitBatch calldata permitBatch,
        bytes calldata signature
    ) external nonReentrant returns (uint256 sharesMinted) {
        if (amountA > type(uint160).max || amountB > type(uint160).max) {
            revert AmountTooLarge();
        }
        // Bind the batch to the two legs we actually pull (spender, window, and each token's amount),
        // accepting either ordering of the two details entries.
        if (
            permitBatch.spender != address(this) || permitBatch.sigDeadline < block.timestamp
                || permitBatch.details.length != 2
        ) revert BadPermit2();
        bool ab = permitBatch.details[0].token == tokenA && permitBatch.details[1].token == tokenB;
        bool ba = permitBatch.details[0].token == tokenB && permitBatch.details[1].token == tokenA;
        if (ab) {
            if (permitBatch.details[0].amount < amountA || permitBatch.details[1].amount < amountB) {
                revert BadPermit2();
            }
        } else if (ba) {
            if (permitBatch.details[0].amount < amountB || permitBatch.details[1].amount < amountA) {
                revert BadPermit2();
            }
        } else {
            revert BadPermit2();
        }
        try PERMIT2.permit(msg.sender, permitBatch, signature) {} catch {}
        PERMIT2.transferFrom(msg.sender, address(this), uint160(amountA), tokenA);
        PERMIT2.transferFrom(msg.sender, address(this), uint160(amountB), tokenB);
        _lazyApprove(tokenA, address(POOL), amountA);
        _lazyApprove(tokenB, address(POOL), amountB);
        sharesMinted = POOL.createPairAndAddLiquidityPublic(
            _evmAssetId(tokenA), _evmAssetId(tokenB), feeBps, amountA, amountB, minSharesOut, deadline, to
        );
        // The pool pays the off-ratio refund to msg.sender (== this router); forward it to the caller.
        _refund(tokenA, msg.sender);
        _refund(tokenB, msg.sender);
    }

    /// @notice Simple native-ETH + ERC20 public LP add. Pulls `tokenAmount` via Permit2, pairs it with
    ///         `msg.value` as the tETH leg, lazily creates the pool if needed, and forwards off-ratio refunds.
    function addLiquidityPublicETHWithPermit2(
        address token,
        uint32 feeBps,
        uint256 tokenAmount,
        uint256 minSharesOut,
        uint64 deadline,
        address to,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) external payable nonReentrant returns (uint256 sharesMinted) {
        _pullPermit2(token, tokenAmount, permitSingle, signature);
        _lazyApprove(token, address(POOL), tokenAmount);
        sharesMinted = POOL.createPairAndAddLiquidityPublic{value: msg.value}(
            _evmAssetId(address(0)), _evmAssetId(token), feeBps, msg.value, tokenAmount, minSharesOut, deadline, to
        );
        _refund(token, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice Remove PUBLIC LP shares through a prior `approveLpOperator(router)` on the pool.
    ///         Outputs are sent directly to `to`.
    function removeLiquidityPublic(
        address tokenA,
        address tokenB,
        uint32 feeBps,
        uint256 shares,
        uint256 minAmountA,
        uint256 minAmountB,
        uint64 deadline,
        address to
    ) external nonReentrant returns (uint256 amountLo, uint256 amountHi) {
        if (to == address(0)) revert BadTarget();
        return POOL.removeLiquidityPublicFrom(
            _evmAssetId(tokenA), _evmAssetId(tokenB), feeBps, shares, minAmountA, minAmountB, deadline, msg.sender, to
        );
    }

    // ──────────────────── Zap: cold-start a public LP from ETH (external sourcing) ────────────────────

    /// @notice Cold-start zap from native ETH: route `ethToSwap` of `msg.value` through zRouter for `tokenB`
    ///         (via the caller's `zrSwapData`, which MUST send the output to this router), then add the
    ///         remaining ETH + the received `tokenB` into the confidential pool's public LP (tETH/tokenB at
    ///         `feeBps`), crediting shares to `to`. The pool is lazily created on the first add (cold start),
    ///         so the (remaining ETH : received tokenB) ratio sets the initial price — the caller chooses
    ///         `ethToSwap` (and the swap's amounts) to land the price they want. Leftovers go back to the caller.
    /// @param tokenB     the ERC20 other leg (registered in the pool); paired with native ETH (tETH).
    /// @param feeBps     the confidential pool's fee tier for the pair.
    /// @param ethToSwap  how much of msg.value to forward to zRouter for the swap (the rest is the ETH leg).
    /// @param minShares  slippage floor on the LP shares minted (the downstream backstop; set the swap's own
    ///                   amountLimit inside `zrSwapData` too).
    /// @param deadline   expiry for the LP add (the swap's own deadline lives in `zrSwapData`).
    /// @param to         recipient of the LP shares.
    /// @param zrSwapData ABI-encoded zRouter swap call (e.g. swapV2/swapV3/swapV4/swapVZ/swapCurve) for the
    ///                   venue with depth, swapping ETH->tokenB with the output recipient set to THIS router.
    function zapETHIntoLP(
        address tokenB,
        uint32 feeBps,
        uint256 ethToSwap,
        uint256 minShares,
        uint64 deadline,
        address to,
        bytes calldata zrSwapData
    ) external payable nonReentrant returns (uint256 sharesMinted) {
        uint256 remainingEth = msg.value - ethToSwap; // reverts (underflow) if ethToSwap > msg.value

        uint256 beforeB = SafeTransferLib.balanceOf(tokenB, address(this));
        _callZRouter(ethToSwap, zrSwapData);
        uint256 gotB = SafeTransferLib.balanceOf(tokenB, address(this)) - beforeB;

        _lazyApprove(tokenB, address(POOL), gotB);
        sharesMinted = POOL.createPairAndAddLiquidityPublic{value: remainingEth}(
            _evmAssetId(address(0)), _evmAssetId(tokenB), feeBps, remainingEth, gotB, minShares, deadline, to
        );

        _refund(tokenB, msg.sender);
        _refundETH(msg.sender);
    }

    // ──────────────────── Zap: confidential-output (public entry, shielded position) ────────────────────

    /// @notice Same public entry (ETH → zRouter → LP) as `zapETHIntoLP`, but the LP position is delivered
    ///         CONFIDENTIALLY: the minted shares are shielded into an owner-blinded LP-share NOTE bound to
    ///         `commit`, so the holder can send it privately or bond it into a farm — vs `zapETHIntoLP`, which
    ///         leaves a PUBLIC lpShares balance. The swap + add are still public (amounts/sender visible); only
    ///         the OUTPUT position is shielded. EXACT legs (`ethLeg`, `tokenBLeg`) make the minted share count
    ///         deterministic (the dapp can pre-derive it). Returns the LP-share-note deposit id.
    function zapETHIntoShieldedLP(
        address tokenB,
        uint32 feeBps,
        uint256 ethLeg,
        uint256 tokenBLeg,
        uint256 minShares,
        uint64 deadline,
        bytes32 commit,
        bytes calldata zrSwapData
    ) external payable nonReentrant returns (bytes32 depositId, uint256 sharesMinted) {
        (depositId, sharesMinted) = _zapToShieldedShares(
            tokenB, feeBps, ethLeg, tokenBLeg, minShares, deadline, commit, zrSwapData
        );
        _refund(tokenB, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice One-tx ETH → CONFIDENTIAL farm position: zap into the LP, shield the shares to `commit`, then
    ///         settle the caller's self-proved batch that consumes the LP-share deposit and bonds it
    ///         (OP_LP_BOND → owner-blinded farm-receipt note earning TAC rewards). Deterministic shares (exact
    ///         legs) let the dapp pre-build the bond proof. Self-proved / fee-free settle (msg.sender == this).
    function zapETHIntoFarm(
        address tokenB,
        uint32 feeBps,
        uint256 ethLeg,
        uint256 tokenBLeg,
        uint256 minShares,
        uint64 deadline,
        bytes32 commit,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable nonReentrant returns (uint256 sharesMinted) {
        (, sharesMinted) = _zapToShieldedShares(
            tokenB, feeBps, ethLeg, tokenBLeg, minShares, deadline, commit, zrSwapData
        );
        _relaySettle(publicValues, proof, memos);
        _refund(tokenB, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice Token-in analog of `zapETHIntoShieldedLP`: pull token A (Permit2), route `tokenAForSwap` of it
    ///         through zRouter for `tokenB`, add EXACTLY (`tokenAForLP`, `tokenBLeg`) to the LP, and shield the
    ///         shares into an owner-blinded LP-share note bound to `z.commit`. Token A is the Permit2 permit's
    ///         token; both legs ERC20. Leftovers swept to the caller.
    function zapTokenIntoShieldedLP(
        TokenZap calldata z,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData
    ) external nonReentrant returns (bytes32 depositId, uint256 sharesMinted) {
        address tokenA = permitSingle.details.token;
        (depositId, sharesMinted) = _zapTokenToShieldedShares(tokenA, z, permitSingle, signature, zrSwapData);
        _refund(tokenA, msg.sender);
        _refund(z.tokenB, msg.sender);
    }

    /// @notice Token-in analog of `zapETHIntoFarm`: token A → shielded LP-share note → settle the caller's
    ///         self-proved bond (OP_LP_BOND). Same deterministic-shares + self-proved/fee-free settle model.
    function zapTokenIntoFarm(
        TokenZap calldata z,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant returns (uint256 sharesMinted) {
        address tokenA = permitSingle.details.token;
        (, sharesMinted) = _zapTokenToShieldedShares(tokenA, z, permitSingle, signature, zrSwapData);
        _relaySettle(publicValues, proof, memos);
        _refund(tokenA, msg.sender);
        _refund(z.tokenB, msg.sender);
    }

    // ──────────────────── Zap: swap-and-wrap (any asset -> a confidential NOTE) ────────────────────

    /// @notice Swap native ETH to `tokenOut` on zRouter, then WRAP exactly `wrapAmount` of it into the
    ///         confidential pool as a deposit bound to `commit` — pay in ETH but receive a confidential
    ///         `tokenOut` NOTE (single asset, not LP). `commit` is the recipient's note commitment, so this is
    ///         a private swap-and-shield (or the deposit leg of swap-and-pay; see zapETHToPayment). The swap
    ///         must source at least `wrapAmount` (which must be unitScale-aligned for `tokenOut`); leftovers
    ///         (excess tokenOut + unspent ETH) are swept to the caller.
    function zapETHToShieldedNote(address tokenOut, uint256 wrapAmount, bytes32 commit, bytes calldata zrSwapData)
        external
        payable
        nonReentrant
    {
        _swapAndWrap(tokenOut, wrapAmount, commit, zrSwapData);
        _refund(tokenOut, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice Swap native ETH to the pool's canonical ERC20 for `assetId`, then burn/wrap it into a
    ///         confidential note. This is the cBTC/cUSD launch path: callers pass the stable shared id
    ///         (e.g. CBTC_ZK_ASSET_ID or the CollateralEngine-derived cUSD id), while the router resolves the
    ///         pool-local wrap id and verifies the canonical token before touching funds.
    function zapETHToCanonicalNote(bytes32 assetId, uint256 wrapAmount, bytes32 commit, bytes calldata zrSwapData)
        external
        payable
        nonReentrant
    {
        address tokenOut = _swapAndWrapCanonical(assetId, wrapAmount, commit, zrSwapData, msg.value);
        _refund(tokenOut, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice Token-in analog of `zapETHToCanonicalNote`: pull any ERC20 via Permit2, route `amountIn` of it
    ///         through zRouter into the pool's canonical ERC20 for `assetId`, then burn/wrap `wrapAmount` into
    ///         a confidential note. Excess input/output is swept back to the caller.
    function zapTokenToCanonicalNoteWithPermit2(
        bytes32 assetId,
        uint256 amountIn,
        uint256 wrapAmount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData
    ) external nonReentrant {
        address tokenIn = permitSingle.details.token;
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        _lazyApprove(tokenIn, ZROUTER, amountIn);
        address tokenOut = _swapAndWrapCanonical(assetId, wrapAmount, commit, zrSwapData, 0);
        _refund(tokenIn, msg.sender);
        _refund(tokenOut, msg.sender);
    }

    /// @notice One-tx private payment funded by ETH in a different asset: swap ETH -> `tokenOut`, wrap exactly
    ///         `wrapAmount` to the recipient's `commit`, then settle the caller's self-proved batch consuming
    ///         the deposit into the recipient's note (+ memo). `wrapAmount` fixes the note value so the dapp
    ///         pre-derives the deposit id for the settle. Self-proved / fee-free settle (msg.sender == this).
    function zapETHToPayment(
        address tokenOut,
        uint256 wrapAmount,
        bytes32 commit,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable nonReentrant {
        _swapAndWrap(tokenOut, wrapAmount, commit, zrSwapData);
        _relaySettle(publicValues, proof, memos);
        _refund(tokenOut, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice One-tx CDP open funded by native ETH through zRouter: swap ETH -> collateral token, wrap
    ///         exactly `wrapAmount`, then settle a CDP-mint proof consuming that deposit. This is the CDP
    ///         analog of `zapETHToPayment`, with a light publicValues guard requiring OP_CDP_MINT intent.
    function zapETHToCdpMint(
        address tokenOut,
        uint256 wrapAmount,
        bytes32 commit,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable nonReentrant {
        _requireCdpMintIntent(publicValues);
        _swapAndWrap(tokenOut, wrapAmount, commit, zrSwapData);
        _relaySettle(publicValues, proof, memos);
        _refund(tokenOut, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice Permit2 token-in CDP zap: pull `amountIn`, route it through zRouter into `tokenOut`, wrap
    ///         exactly `wrapAmount`, then settle the CDP mint proof. Excess input/output is swept back.
    function zapTokenToCdpMintWithPermit2(
        address tokenOut,
        uint256 amountIn,
        uint256 wrapAmount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant {
        _requireCdpMintIntent(publicValues);
        address tokenIn = permitSingle.details.token;
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        _lazyApprove(tokenIn, ZROUTER, amountIn);
        _swapAndWrapWithValue(tokenOut, wrapAmount, commit, zrSwapData, 0);
        _relaySettle(publicValues, proof, memos);
        _refund(tokenIn, msg.sender);
        _refund(tokenOut, msg.sender);
    }

    /// @notice Canonical-asset CDP zap for cBTC/cUSD launch UX: callers pass the shared `assetId` (for
    ///         example cBTC), and the router resolves the local canonical token before wrapping collateral.
    function zapETHToCanonicalCdpMint(
        bytes32 assetId,
        uint256 wrapAmount,
        bytes32 commit,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external payable nonReentrant {
        _requireCdpMintIntent(publicValues);
        address tokenOut = _swapAndWrapCanonical(assetId, wrapAmount, commit, zrSwapData, msg.value);
        _relaySettle(publicValues, proof, memos);
        _refund(tokenOut, msg.sender);
        _refundETH(msg.sender);
    }

    /// @notice Permit2 token-in analog of `zapETHToCanonicalCdpMint`.
    function zapTokenToCanonicalCdpMintWithPermit2(
        bytes32 assetId,
        uint256 amountIn,
        uint256 wrapAmount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData,
        bytes calldata publicValues,
        bytes calldata proof,
        bytes[] calldata memos
    ) external nonReentrant {
        _requireCdpMintIntent(publicValues);
        address tokenIn = permitSingle.details.token;
        _pullPermit2(tokenIn, amountIn, permitSingle, signature);
        _lazyApprove(tokenIn, ZROUTER, amountIn);
        address tokenOut = _swapAndWrapCanonical(assetId, wrapAmount, commit, zrSwapData, 0);
        _relaySettle(publicValues, proof, memos);
        _refund(tokenIn, msg.sender);
        _refund(tokenOut, msg.sender);
    }

    // ──────────────────── Internals: permit pulls + wrap ────────────────────

    /// Pull `amount` of an EIP-2612 token from the caller (its signed allowance) into the router, then lazily
    /// approve the pool. Shared by wrap + swap. `permit` is best-effort (try/catch) so a replayed permit can't
    /// grief the call — the `safeTransferFrom` still enforces the allowance.
    function _pull2612(address token, uint256 amount, uint256 deadline, uint8 v, bytes32 r, bytes32 s) internal {
        try IERC2612(token).permit(msg.sender, address(this), amount, deadline, v, r, s) {} catch {}
        SafeTransferLib.safeTransferFrom(token, msg.sender, address(this), amount);
        _lazyApprove(token, address(POOL), amount);
    }

    /// Permit2 analog of `_pull2612` (any ERC20 after a one-time `token.approve(PERMIT2, max)`).
    function _pullPermit2(
        address token,
        uint256 amount,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) internal {
        if (amount > type(uint160).max) revert AmountTooLarge(); // Permit2 amounts are uint160
        // Bind the signed permit to what we actually pull: the wallet-displayed token/spender/amount/window
        // must match this transfer, so a stale or mismatched permit can't be steered onto a different asset.
        if (
            permitSingle.details.token != token || permitSingle.spender != address(this)
                || permitSingle.details.amount < amount || permitSingle.sigDeadline < block.timestamp
        ) revert BadPermit2();
        try PERMIT2.permit(msg.sender, permitSingle, signature) {} catch {}
        PERMIT2.transferFrom(msg.sender, address(this), uint160(amount), token);
        _lazyApprove(token, address(POOL), amount);
    }

    function _wrap2612(address token, uint256 amount, bytes32 commit, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        internal
    {
        _pull2612(token, amount, deadline, v, r, s);
        POOL.wrap(_evmAssetId(token), amount, commit);
    }

    function _wrapPermit2(
        address token,
        uint256 amount,
        bytes32 commit,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature
    ) internal {
        _pullPermit2(token, amount, permitSingle, signature);
        POOL.wrap(_evmAssetId(token), amount, commit);
    }

    /// Forward `amount` of native ETH to the pool's wrap (no approval — the pool checks msg.value == amount
    /// for the native-ETH asset). The native-ETH asset id is `_evmAssetId(address(0))` — the same id the pool
    /// registered tETH under.
    function _wrapETH(uint256 amount, bytes32 commit) internal {
        POOL.wrap{value: amount}(_evmAssetId(address(0)), amount, commit);
    }

    // ──────────────────── Exit-and-call (shielded exit → pinned zRouter, atomic) ────────────────────

    /// A bound exit recipe. The pool unwraps `exitedAsset` TO `escrowAddressFor(recipe)` — a CREATE2 address
    /// keyed by the recipe hash — so the PROOF itself commits the recipe (via its existing withdrawal recipient
    /// field). A front-runner cannot redirect the output or alter the route without changing that address; since
    /// the proof's funds went to the honest caller's escrow, an attacker's call reverts on an empty escrow.
    struct ExitRecipe {
        bytes32 exitedAsset; // asset id the proof withdraws to the escrow (ERC20 exits only)
        address tokenOut; // token the zRouter route returns to this router
        uint256 minOut; // slippage floor on tokenOut delivered to finalRecipient
        address finalRecipient; // destination of the route output
        uint64 deadline; // recipe expiry (unix secs)
        uint256 nonce; // makes the escrow address one-shot
        bytes zCalldata; // calldata for the PINNED zRouter (it performs the multi-protocol routing)
    }

    /// keccak of the empty-constructor ExitEscrow creation code — the only initcode this router ever CREATE2s.
    bytes32 private constant EXIT_ESCROW_INITCODE_HASH = keccak256(type(ExitEscrow).creationCode);

    error ExitEmpty();
    error ExitExpired();
    error ExitMinOut();

    /// The deterministic escrow address the caller MUST set as the proof's withdrawal recipient for `recipe`.
    function escrowAddressFor(ExitRecipe calldata recipe) public view returns (address) {
        bytes32 salt = keccak256(abi.encode(recipe));
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), salt, EXIT_ESCROW_INITCODE_HASH))))
        );
    }

    /// @notice Atomically exit a note out of the pool and route it through the PINNED zRouter. The settle proof
    ///         MUST withdraw `recipe.exitedAsset` to `escrowAddressFor(recipe)`, which binds the whole recipe to
    ///         the proof (defeating mempool front-running). ERC20 exits only; the proof should be self-settled
    ///         (fee = 0) so nothing rests here. Output + any unrouted input go to `finalRecipient`.
    function exitAndCall(
        bytes calldata publicValues,
        bytes calldata proofBytes,
        bytes[] calldata memos,
        ExitRecipe calldata recipe
    ) external nonReentrant returns (uint256 amountOut) {
        if (recipe.finalRecipient == address(0) || recipe.finalRecipient == address(this)) revert BadTarget();
        if (block.timestamp > recipe.deadline) revert ExitExpired();
        (, address tokenIn,,,,) = POOL.assets(recipe.exitedAsset);
        if (tokenIn == address(0)) revert BadTarget(); // ERC20 exits only; native-ETH exit-and-call is a follow-up

        // Settle: the proof unwraps `exitedAsset` to the recipe-bound escrow address (the caller built it so).
        POOL.settle(publicValues, proofBytes, memos);

        // Deploy the escrow at the recipe-bound address and pull the unwrapped funds in. A tampered recipe ⇒ a
        // different address with no funds ⇒ this reverts, so the recipe is non-malleable.
        uint256 beforeIn = SafeTransferLib.balanceOf(tokenIn, address(this));
        ExitEscrow escrow = new ExitEscrow{salt: keccak256(abi.encode(recipe))}();
        escrow.sweep(tokenIn);
        uint256 amountIn = SafeTransferLib.balanceOf(tokenIn, address(this)) - beforeIn;
        if (amountIn == 0) revert ExitEmpty();

        // Route through the PINNED zRouter — the only external target; standing allowance only to it.
        uint256 beforeOut = SafeTransferLib.balanceOf(recipe.tokenOut, address(this));
        _lazyApprove(tokenIn, ZROUTER, amountIn);
        _callZRouter(0, recipe.zCalldata);
        amountOut = SafeTransferLib.balanceOf(recipe.tokenOut, address(this)) - beforeOut;
        if (amountOut < recipe.minOut) revert ExitMinOut();

        // Deliver the output + refund any unrouted input. No resting balance.
        SafeTransferLib.safeTransfer(recipe.tokenOut, recipe.finalRecipient, amountOut);
        uint256 dust = SafeTransferLib.balanceOf(tokenIn, address(this)) - beforeIn;
        if (dust != 0) SafeTransferLib.safeTransfer(tokenIn, recipe.finalRecipient, dust);
    }

    // ──────────────────── Internals: zaps ────────────────────

    /// Low-level call the PINNED zRouter with the caller's swap calldata, forwarding `value` ETH; bubble its
    /// revert reason (or ZRouterCallFailed). The router holds no standing approval to zRouter for ETH paths;
    /// hostile/mis-built calldata that returns too little output is caught by downstream balance-delta or
    /// slippage checks, reverting the whole transaction.
    function _callZRouter(uint256 value, bytes calldata zrSwapData) internal {
        if (ZROUTER == address(0)) revert BadTarget();
        (bool ok, bytes memory ret) = ZROUTER.call{value: value}(zrSwapData);
        if (!ok) {
            if (ret.length != 0) {
                assembly ("memory-safe") {
                    revert(add(ret, 0x20), mload(ret))
                }
            }
            revert ZRouterCallFailed();
        }
    }

    /// Swap msg.value of ETH to `tokenOut` on zRouter (caller's calldata, output to this), then wrap EXACTLY
    /// `wrapAmount` into the pool as a deposit for `commit`. The swap must source >= wrapAmount.
    function _swapAndWrap(address tokenOut, uint256 wrapAmount, bytes32 commit, bytes calldata zrSwapData) internal {
        _swapAndWrapWithValue(tokenOut, wrapAmount, commit, zrSwapData, msg.value);
    }

    function _swapAndWrapWithValue(
        address tokenOut,
        uint256 wrapAmount,
        bytes32 commit,
        bytes calldata zrSwapData,
        uint256 value
    ) internal {
        uint256 beforeOut = SafeTransferLib.balanceOf(tokenOut, address(this));
        _callZRouter(value, zrSwapData);
        require(SafeTransferLib.balanceOf(tokenOut, address(this)) - beforeOut >= wrapAmount, "zap: short swap output");
        _lazyApprove(tokenOut, address(POOL), wrapAmount);
        POOL.wrap(_evmAssetId(tokenOut), wrapAmount, commit);
    }

    /// Resolve a launch canonical/shared id (cBTC/cUSD) to the pool-local wrap id and canonical ERC20, then
    /// swap into that ERC20 and re-enter the confidential pool by burning/wrapping the local id.
    function _swapAndWrapCanonical(
        bytes32 assetId,
        uint256 wrapAmount,
        bytes32 commit,
        bytes calldata zrSwapData,
        uint256 value
    ) internal returns (address tokenOut) {
        tokenOut = POOL.canonicalTokenFor(assetId);
        if (tokenOut == address(0)) revert BadTarget();
        bytes32 wrapAssetId = POOL.localAssetOf(assetId);
        if (wrapAssetId == bytes32(0)) wrapAssetId = assetId;
        if (POOL.canonicalTokenFor(wrapAssetId) != tokenOut) revert BadTarget();

        uint256 beforeOut = SafeTransferLib.balanceOf(tokenOut, address(this));
        _callZRouter(value, zrSwapData);
        require(SafeTransferLib.balanceOf(tokenOut, address(this)) - beforeOut >= wrapAmount, "zap: short swap output");
        _lazyApprove(tokenOut, address(POOL), wrapAmount);
        POOL.wrap(wrapAssetId, wrapAmount, commit);
    }

    /// Exact-leg zap → shield the LP shares into a note deposit. Swaps for AT LEAST `tokenBLeg` on zRouter
    /// (caller's exact-out calldata), adds EXACTLY (ethLeg, tokenBLeg) to the LP (so the minted share count is
    /// deterministic), and shields the minted shares to `commit`. Leftovers are swept by the public caller.
    function _zapToShieldedShares(
        address tokenB,
        uint32 feeBps,
        uint256 ethLeg,
        uint256 tokenBLeg,
        uint256 minShares,
        uint64 deadline,
        bytes32 commit,
        bytes calldata zrSwapData
    ) internal returns (bytes32 depositId, uint256 sharesMinted) {
        uint256 ethForSwap = msg.value - ethLeg; // reverts (underflow) if ethLeg > msg.value
        uint256 beforeB = SafeTransferLib.balanceOf(tokenB, address(this));
        _callZRouter(ethForSwap, zrSwapData);
        require(SafeTransferLib.balanceOf(tokenB, address(this)) - beforeB >= tokenBLeg, "zap: short swap output");
        bytes32 tethId = _evmAssetId(address(0));
        bytes32 tokenBId = _evmAssetId(tokenB);
        _lazyApprove(tokenB, address(POOL), tokenBLeg);
        // EXACT legs ⇒ deterministic shares; `to == this` so the router holds them to shield.
        sharesMinted = POOL.createPairAndAddLiquidityPublic{value: ethLeg}(
            tethId, tokenBId, feeBps, ethLeg, tokenBLeg, minShares, deadline, address(this)
        );
        depositId = POOL.shieldShares(_poolId(tethId, tokenBId, feeBps), sharesMinted, commit);
    }

    /// Token-in core: pull token A (Permit2), swap `tokenAForSwap` of it on zRouter for >= tokenBLeg, add
    /// EXACTLY (tokenAForLP, tokenBLeg) to the LP (deterministic shares), and shield the shares to `commit`.
    function _zapTokenToShieldedShares(
        address tokenA,
        TokenZap calldata z,
        IPermit2.PermitSingle calldata permitSingle,
        bytes calldata signature,
        bytes calldata zrSwapData
    ) internal returns (bytes32 depositId, uint256 sharesMinted) {
        uint256 total = z.tokenAForSwap + z.tokenAForLP;
        _pullPermit2(tokenA, total, permitSingle, signature);
        _lazyApprove(tokenA, ZROUTER, z.tokenAForSwap); // let zRouter pull the swap input
        uint256 beforeB = SafeTransferLib.balanceOf(z.tokenB, address(this));
        _callZRouter(0, zrSwapData); // token-in: no ETH forwarded (zRouter pulls the approved token)
        require(SafeTransferLib.balanceOf(z.tokenB, address(this)) - beforeB >= z.tokenBLeg, "zap: short swap output");
        bytes32 tokenAId = _evmAssetId(tokenA);
        bytes32 tokenBId = _evmAssetId(z.tokenB);
        _lazyApprove(tokenA, address(POOL), z.tokenAForLP);
        _lazyApprove(z.tokenB, address(POOL), z.tokenBLeg);
        sharesMinted = POOL.createPairAndAddLiquidityPublic(
            tokenAId, tokenBId, z.feeBps, z.tokenAForLP, z.tokenBLeg, z.minShares, z.deadline, address(this)
        );
        depositId = POOL.shieldShares(_poolId(tokenAId, tokenBId, z.feeBps), sharesMinted, z.commit);
    }

    /// Canonical poolId — a byte-for-byte mirror of ConfidentialPool._poolId (keccak(lo ‖ hi ‖ feeBps)).
    function _poolId(bytes32 a, bytes32 b, uint32 feeBps) internal pure returns (bytes32 poolId) {
        (bytes32 lo, bytes32 hi) = a < b ? (a, b) : (b, a);
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, lo)
            mstore(add(m, 0x20), hi)
            mstore(add(m, 0x40), and(feeBps, 0xffffffff))
            poolId := keccak256(m, 0x60)
        }
    }

    // ──────────────────── Internals: approvals, refunds, asset id ────────────────────

    /// Lazily grant `spender` (the pinned pool, or zRouter for token-in) an infinite allowance — once per
    /// (token, spender) — vs a fresh approve every call, saving the ~20k SSTORE on every repeat. Safe: the
    /// router holds no token balance between calls (nothing to pull) and spenders are pinned. `safeApprove…`
    /// resets-then-sets for tokens (USDT-style) that require a 0 allowance first; a token that decrements an
    /// infinite allowance just trips the `< amount` check later and is re-approved.
    function _lazyApprove(address token, address spender, uint256 amount) internal {
        if (IERC20Allowance(token).allowance(address(this), spender) < amount) {
            SafeTransferLib.safeApproveWithRetry(token, spender, type(uint256).max);
        }
    }

    function _checkPath(address[] calldata path, uint32[] calldata fees, address to) internal view {
        if (path.length == 0 || path.length != fees.length || to == address(0) || to == address(this)) {
            revert BadPath();
        }
        for (uint256 i; i < path.length; ++i) {
            if (path[i] == address(0)) revert BadPath();
        }
    }

    function _swapPublicPath(
        address tokenIn,
        address[] calldata path,
        uint32[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to
    ) internal returns (uint256 amountOut) {
        address curToken = tokenIn;
        uint256 curAmount = amountIn;
        for (uint256 i; i < path.length; ++i) {
            address nextToken = path[i];
            bool last = i == path.length - 1;
            _lazyApprove(curToken, address(POOL), curAmount);
            curAmount = POOL.swapPublic(
                _evmAssetId(curToken),
                _evmAssetId(nextToken),
                fees[i],
                curAmount,
                last ? minAmountOut : 0,
                deadline,
                last ? to : address(this)
            );
            curToken = nextToken;
        }
        amountOut = curAmount;
    }

    function _swapPublicETHPath(
        address[] calldata path,
        uint32[] calldata fees,
        uint256 amountIn,
        uint256 minAmountOut,
        uint64 deadline,
        address to
    ) internal returns (uint256 amountOut) {
        uint256 curAmount = amountIn;
        bytes32 curAsset = _evmAssetId(address(0));
        for (uint256 i; i < path.length; ++i) {
            address nextToken = path[i];
            bool last = i == path.length - 1;
            curAmount = POOL.swapPublic{value: i == 0 ? amountIn : 0}(
                curAsset,
                _evmAssetId(nextToken),
                fees[i],
                curAmount,
                last ? minAmountOut : 0,
                deadline,
                last ? to : address(this)
            );
            curAsset = _evmAssetId(nextToken);
            if (!last) _lazyApprove(nextToken, address(POOL), curAmount);
        }
        amountOut = curAmount;
    }

    function _publicPathAmountInForExactOut(
        address tokenIn,
        address[] calldata path,
        uint32[] calldata fees,
        uint256 amountOut
    ) internal view returns (uint256 amountIn) {
        uint256 needed = amountOut;
        for (uint256 i = path.length; i != 0;) {
            unchecked {
                --i;
            }
            bytes32 assetIn = i == 0 ? _evmAssetId(tokenIn) : _evmAssetId(path[i - 1]);
            needed = _publicAmountInForExactOut(assetIn, _evmAssetId(path[i]), fees[i], needed);
        }
        amountIn = needed;
    }

    function _publicETHPathAmountInForExactOut(address[] calldata path, uint32[] calldata fees, uint256 amountOut)
        internal
        view
        returns (uint256 amountIn)
    {
        uint256 needed = amountOut;
        for (uint256 i = path.length; i != 0;) {
            unchecked {
                --i;
            }
            bytes32 assetIn = i == 0 ? _evmAssetId(address(0)) : _evmAssetId(path[i - 1]);
            needed = _publicAmountInForExactOut(assetIn, _evmAssetId(path[i]), fees[i], needed);
        }
        amountIn = needed;
    }

    function _publicAmountInForExactOut(bytes32 assetIn, bytes32 assetOut, uint32 feeBps, uint256 amountOut)
        internal
        view
        returns (uint256 amountIn)
    {
        if (amountOut == 0) revert BadPath();
        uint256 inScale = _unitScale(assetIn);
        uint256 outScale = _unitScale(assetOut);
        uint256 valueOut = _ceilDiv(amountOut, outScale);
        (uint256 reserveIn, uint256 reserveOut) = _publicReserves(assetIn, assetOut, feeBps);
        if (valueOut == 0 || valueOut >= reserveOut || feeBps >= 10000) revert BadPath();
        uint256 num = reserveIn * valueOut * 10000;
        uint256 den = (reserveOut - valueOut) * (10000 - uint256(feeBps));
        amountIn = ((num / den) + 1) * inScale;
    }

    function _publicReserves(bytes32 assetIn, bytes32 assetOut, uint32 feeBps)
        internal
        view
        returns (uint256 reserveIn, uint256 reserveOut)
    {
        (bool init, bytes32 assetA, bytes32 assetB, uint256 reserveA, uint256 reserveB, uint32 gotFee,) =
            POOL.pools(_poolId(assetIn, assetOut, feeBps));
        if (!init || gotFee != feeBps) revert BadPath();
        if (assetIn == assetA && assetOut == assetB) return (reserveA, reserveB);
        if (assetIn == assetB && assetOut == assetA) return (reserveB, reserveA);
        revert BadPath();
    }

    function _unitScale(bytes32 assetId) internal view returns (uint256 unitScale) {
        bool registered;
        (registered,, unitScale,,,) = POOL.assets(assetId);
        if (!registered || unitScale == 0) revert BadTarget();
    }

    function _ceilDiv(uint256 a, uint256 b) internal pure returns (uint256) {
        return a == 0 ? 0 : ((a - 1) / b) + 1;
    }

    /// `PublicValues` is ABI-encoded as one tuple argument (`abi.encode(pv)`), so word 0 is the tuple offset.
    /// Field 22 is `cdpMints`; requiring a non-empty array prevents CDP-named entrypoints from accidentally
    /// accepting a plain private-payment settle while leaving full semantic validation to the pool + proof.
    function _requireCdpMintIntent(bytes calldata publicValues) internal pure {
        uint256 tupleStart;
        uint256 cdpOffset;
        uint256 cdpLen;
        assembly ("memory-safe") {
            tupleStart := calldataload(publicValues.offset)
        }
        if (tupleStart > publicValues.length || publicValues.length - tupleStart < 27 * 32) {
            revert BadProofIntent();
        }
        assembly ("memory-safe") {
            cdpOffset := calldataload(add(add(publicValues.offset, tupleStart), mul(22, 32)))
        }
        if (cdpOffset > publicValues.length || tupleStart + cdpOffset > publicValues.length - 32) {
            revert BadProofIntent();
        }
        assembly ("memory-safe") {
            cdpLen := calldataload(add(add(publicValues.offset, tupleStart), cdpOffset))
        }
        if (cdpLen == 0) revert BadProofIntent();
    }

    /// Every router-relayed settle runs with `msg.sender == this router`, so a settler-fee leg would pay the
    /// router and a fee in any non-input asset would strand here with no sweep. The router settle paths are
    /// fee-free by construction; enforce it fail-closed (`PublicValues` field 7 is `fees`) instead of silently
    /// accruing dust, then forward to the pool.
    function _relaySettle(bytes calldata publicValues, bytes calldata proof, bytes[] calldata memos) internal {
        uint256 tupleStart;
        uint256 feesOffset;
        uint256 feesLen;
        assembly ("memory-safe") {
            tupleStart := calldataload(publicValues.offset)
        }
        if (tupleStart > publicValues.length || publicValues.length - tupleStart < 27 * 32) {
            revert BadProofIntent();
        }
        assembly ("memory-safe") {
            feesOffset := calldataload(add(add(publicValues.offset, tupleStart), mul(7, 32)))
        }
        if (feesOffset > publicValues.length || tupleStart + feesOffset > publicValues.length - 32) {
            revert BadProofIntent();
        }
        assembly ("memory-safe") {
            feesLen := calldataload(add(add(publicValues.offset, tupleStart), feesOffset))
        }
        if (feesLen != 0) revert BadProofIntent();
        POOL.settle(publicValues, proof, memos);
    }

    /// Forward the router's full balance of `token` to `to` — pool off-ratio refunds + swap dust — so the
    /// router never retains a token balance across calls.
    function _refund(address token, address to) internal {
        uint256 bal = SafeTransferLib.balanceOf(token, address(this));
        if (bal != 0) SafeTransferLib.safeTransfer(token, to, bal);
    }

    function _refundETH(address to) internal {
        uint256 bal = address(this).balance;
        if (bal != 0) SafeTransferLib.forceSafeTransferETH(to, bal);
    }

    /// The pool's internal asset id for an underlying ERC20 — MUST mirror ConfidentialPool._evmAssetId:
    /// sha256("tacit-evm-token-v1" ‖ chainid ‖ underlying). Every registerWrapped/_register keys the asset
    /// under exactly this id, so deriving it here lets the caller pass only the token address (address(0) for
    /// native ETH/tETH). A token whose derived id isn't registered simply makes the pool revert (fail-closed).
    function _evmAssetId(address underlying) internal view returns (bytes32 assetId) {
        assembly ("memory-safe") {
            let m := mload(0x40)
            mstore(m, shl(112, 0x74616369742d65766d2d746f6b656e2d7631)) // "tacit-evm-token-v1"
            mstore(add(m, 18), shl(192, chainid()))
            mstore(add(m, 26), shl(96, underlying))
            if iszero(staticcall(gas(), 2, m, 46, m, 32)) { revert(0, 0) }
            assetId := mload(m)
        }
    }

    /// Accept the pool's native-ETH off-ratio refund (forceSafeTransferETH) so it lands cleanly to be swept.
    receive() external payable {}
}

/// Minimal CREATE2 escrow for atomic exit-and-call. The pool unwraps a note TO this contract's deterministic
/// address (salt = the exit-recipe hash), so the proof commits the recipe. Only the deployer (the router) can
/// sweep, and only to itself — so the bound recipe is the sole way the funds move. Holds nothing across txs.
contract ExitEscrow {
    address private immutable DEPLOYER;

    constructor() {
        DEPLOYER = msg.sender;
    }

    /// Sweep this escrow's full balance of `token` to the deployer (the router). Deployer-only.
    function sweep(address token) external {
        require(msg.sender == DEPLOYER, "exit-escrow: only deployer");
        uint256 bal = SafeTransferLib.balanceOf(token, address(this));
        if (bal != 0) SafeTransferLib.safeTransfer(token, DEPLOYER, bal);
    }
}
