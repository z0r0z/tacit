// Dapp-side ConfidentialRouter periphery client. The router collapses "approve + wrap" (and the public-AMM /
// zap flows) into one user-sent transaction via a signature-based approval (EIP-2612 / Permit2 / native
// msg.value). The router always pulls from msg.sender, so the tx is ALWAYS user-sent — each builder returns
// { to, value, calldata } ready for evm-tx.signEip1559, exactly like confidential-pool-ux.buildWrap, but the
// calldata targets the router (with a signed permit) instead of pool.wrap.
//
// Phase 1 (this file): the PROOF-FREE flows — the router call needs no SP1 proof. Wrap on-ramp (EIP-2612 /
// Permit2 / native ETH; the note is minted by a later settle), public swap, public LP add. The atomic-settle
// flows (wrapAndSettle* / zapETHToPayment / farm bonds — which embed a box proof) and the zRouter zaps layer
// on in later phases. See ops/PLAN-confidential-router-dapp-wiring.md.
//
// The caller supplies on-chain-read inputs the router needs (the token's EIP-2612 name/version + permit nonce,
// or the Permit2 nonce) — fetched via RPC by the UX layer; this module is pure assembly + signing so it stays
// browser-safe and unit-testable offline. Deps injected: { secp, keccak256, sha256, cfg }.

export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const ZROUTER_ADDRESS = '0x000000000000FB114709235f1ccBFfb925F600e4';

export function makeConfidentialRouter({ secp, keccak256, sha256, cfg } = {}) {
  if (!cfg) throw new Error('makeConfidentialRouter: cfg required');
  const chainId = BigInt(cfg.chainId);
  const permit2 = String(cfg.permit2 || PERMIT2_ADDRESS).toLowerCase();
  // The router address is required only by the builders that emit a tx; signing/encoding helpers work without
  // it (so the module is unit-testable before a deploy). routerAddr() throws with a clear message if unset.
  const _router = cfg.router ? String(cfg.router).toLowerCase() : null;
  function routerAddr() {
    if (!_router) throw new Error('cfg.router not set (deploy the ConfidentialRouter, then set cfg.router)');
    return _router;
  }

  // ── hex / abi-word helpers ──
  const utf8 = (s) => new TextEncoder().encode(s);
  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const concat = (...arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  // 32-byte ABI word from a bigint / decimal / 0x-hex scalar.
  const word = (v) => {
    if (typeof v === 'bigint') return v.toString(16).padStart(64, '0');
    const s = String(v);
    return (s.startsWith('0x') ? s.slice(2) : BigInt(s).toString(16)).padStart(64, '0');
  };
  // 20-byte address left-padded to a 32-byte ABI word.
  const addrWord = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const keccakHex = (bytes) => '0x' + bytesToHex(keccak256(bytes));
  const selector = (sig) => bytesToHex(keccak256(utf8(sig)).subarray(0, 4));

  // ── ConfidentialPool._evmAssetId mirror: sha256("tacit-evm-token-v1" ‖ chainid_be8 ‖ underlying20). Native
  //    ETH (tETH) is address(0). Matches cross-chain-asset-resolver.js + ConfidentialPool.sol. ──
  const be8 = (n) => { const o = new Uint8Array(8); let v = BigInt(n); for (let i = 7; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  function evmAssetId(underlying = '0x0000000000000000000000000000000000000000') {
    const u = hexToBytes(String(underlying).replace(/^0x/, '').toLowerCase().padStart(40, '0'));
    return '0x' + bytesToHex(sha256(concat(utf8('tacit-evm-token-v1'), be8(chainId), u)));
  }

  // ── EIP-712 ──
  const DOMAIN_TYPEHASH_NVCV = keccakHex(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const DOMAIN_TYPEHASH_NCV = keccakHex(utf8('EIP712Domain(string name,uint256 chainId,address verifyingContract)'));
  const PERMIT_2612_TYPEHASH = keccakHex(utf8('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
  const PERMIT_DETAILS_TYPEHASH = keccakHex(utf8('PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)'));
  const PERMIT_SINGLE_TYPEHASH = keccakHex(utf8('PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)'));
  const PERMIT_BATCH_TYPEHASH = keccakHex(utf8('PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)'));

  // hashStruct/digest take a list of 32-byte hex words (0x-prefixed) and keccak their concatenation.
  const hashWords = (words) => keccakHex(concat(...words.map(hexToBytes)));
  const w = (v) => '0x' + word(v);
  const aw = (a) => '0x' + addrWord(a);
  function digest712(domainSeparator, structHash) {
    return keccakHex(concat(Uint8Array.of(0x19, 0x01), hexToBytes(domainSeparator), hexToBytes(structHash)));
  }
  function sign712(digestHex, priv) {
    const sig = secp.sign(hexToBytes(digestHex), hexToBytes(String(priv).replace(/^0x/, '')));
    const v = 27 + Number(sig.recovery);
    const r = '0x' + sig.r.toString(16).padStart(64, '0');
    const s = '0x' + sig.s.toString(16).padStart(64, '0');
    // 65-byte r‖s‖v — the form Permit2 (and the router) recover.
    const signature = '0x' + sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0') + v.toString(16).padStart(2, '0');
    return { v, r, s, signature };
  }

  // EIP-2612: sign token.permit(owner, spender=router, value, nonce, deadline). The token's domain needs its
  // name/version (per token — fetch via name()/version() or eip712Domain(); USDC = "USD Coin"/"2").
  function signErc2612({ token, name, version = '1', owner, value, nonce, deadline, priv, spender }) {
    const sp = spender || routerAddr();
    const domain = hashWords([DOMAIN_TYPEHASH_NVCV, keccakHex(utf8(name)), keccakHex(utf8(version)), w(chainId), aw(token)]);
    const sh = hashWords([PERMIT_2612_TYPEHASH, aw(owner), aw(sp), w(BigInt(value)), w(BigInt(nonce)), w(BigInt(deadline))]);
    return sign712(digest712(domain, sh), priv);
  }

  const permit2Domain = () => hashWords([DOMAIN_TYPEHASH_NCV, keccakHex(utf8('Permit2')), w(chainId), aw(permit2)]);
  const detailsHash = (d) => hashWords([PERMIT_DETAILS_TYPEHASH, aw(d.token), w(BigInt(d.amount)), w(BigInt(d.expiration)), w(BigInt(d.nonce))]);

  // Permit2 PermitSingle — one token. Returns { permitSingle, signature } ready for the calldata builders.
  function signPermit2Single({ token, amount, expiration, nonce, sigDeadline, priv, spender }) {
    const sp = spender || routerAddr();
    const details = { token, amount: String(amount), expiration: Number(expiration), nonce: Number(nonce) };
    const sh = hashWords([PERMIT_SINGLE_TYPEHASH, detailsHash(details), aw(sp), w(BigInt(sigDeadline))]);
    const { signature } = sign712(digest712(permit2Domain(), sh), priv);
    return { permitSingle: { details, spender: sp, sigDeadline: String(sigDeadline) }, signature };
  }

  // Permit2 PermitBatch — N tokens, one signature (used by addLiquidityPublicWithPermit2).
  function signPermit2Batch({ details, sigDeadline, priv, spender }) {
    const sp = spender || routerAddr();
    const norm = details.map((d) => ({ token: d.token, amount: String(d.amount), expiration: Number(d.expiration), nonce: Number(d.nonce) }));
    const arrHash = keccakHex(concat(...norm.map((d) => hexToBytes(detailsHash(d)))));
    const sh = hashWords([PERMIT_BATCH_TYPEHASH, arrHash, aw(sp), w(BigInt(sigDeadline))]);
    const { signature } = sign712(digest712(permit2Domain(), sh), priv);
    return { permitBatch: { details: norm, spender: sp, sigDeadline: String(sigDeadline) }, signature };
  }

  // ── ABI encoding ──
  // PermitSingle is fully STATIC (6 words): (token, amount, expiration, nonce, spender, sigDeadline).
  const encPermitSingle = (ps) => addrWord(ps.details.token) + word(BigInt(ps.details.amount)) + word(BigInt(ps.details.expiration)) + word(BigInt(ps.details.nonce)) + addrWord(ps.spender) + word(BigInt(ps.sigDeadline));
  // A dynamic `bytes` tail: length word + right-padded data.
  function encBytes(hex) {
    const b = String(hex || '').replace(/^0x/, '');
    const pad = (64 - (b.length % 64)) % 64;
    return word(BigInt(b.length / 2)) + b + '0'.repeat(pad);
  }
  // PermitBatch is DYNAMIC (details[] is a dynamic array): tuple head [offsetToDetails=0x60, spender,
  // sigDeadline] then the array [len, det0(4w), det1(4w), …]. Returned WITHOUT a leading offset (the caller
  // places it in the args tail).
  function encPermitBatch(pb) {
    const head = word(BigInt(0x60)) + addrWord(pb.spender) + word(BigInt(pb.sigDeadline));
    let arr = word(BigInt(pb.details.length));
    for (const d of pb.details) arr += addrWord(d.token) + word(BigInt(d.amount)) + word(BigInt(d.expiration)) + word(BigInt(d.nonce));
    return head + arr;
  }

  // ── Calldata builders (proof-free) ──
  function wrapWithPermitCalldata({ token, amount, commit, deadline, v, r, s }) {
    return '0x' + selector('wrapWithPermit(address,uint256,bytes32,uint256,uint8,bytes32,bytes32)')
      + addrWord(token) + word(BigInt(amount)) + word(commit) + word(BigInt(deadline)) + word(BigInt(v)) + word(r) + word(s);
  }

  function wrapWithPermit2Calldata({ token, amount, commit, permitSingle, signature }) {
    // head: token, amount, commit, permitSingle(6), sigOffset → 3 + 6 + 1 = 10 words ⇒ offset 0x140
    const head = addrWord(token) + word(BigInt(amount)) + word(commit) + encPermitSingle(permitSingle);
    return '0x' + selector('wrapWithPermit2(address,uint256,bytes32,((address,uint160,uint48,uint48),address,uint256),bytes)')
      + head + word(BigInt(10 * 32)) + encBytes(signature);
  }

  function wrapETHCalldata({ commit }) {
    return '0x' + selector('wrapETH(bytes32)') + word(commit);
  }

  function swapPublicWithPermitCalldata({ tokenIn, tokenOut, feeBps, amountIn, minAmountOut, deadline, to, v, r, s }) {
    return '0x' + selector('swapPublicWithPermit(address,address,uint32,uint256,uint256,uint64,address,uint8,bytes32,bytes32)')
      + addrWord(tokenIn) + addrWord(tokenOut) + word(BigInt(feeBps)) + word(BigInt(amountIn)) + word(BigInt(minAmountOut))
      + word(BigInt(deadline)) + addrWord(to) + word(BigInt(v)) + word(r) + word(s);
  }

  function swapPublicWithPermit2Calldata({ tokenIn, tokenOut, feeBps, amountIn, minAmountOut, deadline, to, permitSingle, signature }) {
    // head: 7 static + permitSingle(6) + sigOffset = 14 words ⇒ offset 0x1c0
    const head = addrWord(tokenIn) + addrWord(tokenOut) + word(BigInt(feeBps)) + word(BigInt(amountIn)) + word(BigInt(minAmountOut))
      + word(BigInt(deadline)) + addrWord(to) + encPermitSingle(permitSingle);
    return '0x' + selector('swapPublicWithPermit2(address,address,uint32,uint256,uint256,uint64,address,((address,uint160,uint48,uint48),address,uint256),bytes)')
      + head + word(BigInt(14 * 32)) + encBytes(signature);
  }

  function addLiquidityPublicWithPermit2Calldata({ tokenA, tokenB, feeBps, amountA, amountB, minSharesOut, deadline, to, permitBatch, signature }) {
    // head: 8 static + permitBatchOffset + sigOffset = 10 words. permitBatch at 0x140; signature follows it.
    const head = addrWord(tokenA) + addrWord(tokenB) + word(BigInt(feeBps)) + word(BigInt(amountA)) + word(BigInt(amountB))
      + word(BigInt(minSharesOut)) + word(BigInt(deadline)) + addrWord(to);
    const batchBlob = encPermitBatch(permitBatch);
    const batchOffset = 10 * 32;
    const sigOffset = batchOffset + batchBlob.length / 2;
    return '0x' + selector('addLiquidityPublicWithPermit2(address,address,uint32,uint256,uint256,uint256,uint64,address,((address,uint160,uint48,uint48)[],address,uint256),bytes)')
      + head + word(BigInt(batchOffset)) + word(BigInt(sigOffset)) + batchBlob + encBytes(signature);
  }

  // ── High-level builders: sign the permit + assemble { to, value, calldata } for evm-tx.signEip1559 ──
  // The caller supplies `commit` (from confidential-pool-ux's note derivation / an invoice) + the on-chain
  // nonces. `amount` is the underlying amount (wei-scale); `value` is always 0 except wrapETH.

  function buildWrapWithPermit({ priv, owner, token, name, version, amount, commit, tokenNonce, deadline }) {
    const sig = signErc2612({ token, name, version, owner, value: amount, nonce: tokenNonce, deadline, priv });
    return { to: routerAddr(), value: 0n, calldata: wrapWithPermitCalldata({ token, amount, commit, deadline, v: sig.v, r: sig.r, s: sig.s }), permitSig: sig };
  }

  function buildWrapWithPermit2({ priv, token, amount, commit, permit2Nonce, expiration, sigDeadline }) {
    const { permitSingle, signature } = signPermit2Single({ token, amount, expiration, nonce: permit2Nonce, sigDeadline, priv });
    return { to: routerAddr(), value: 0n, calldata: wrapWithPermit2Calldata({ token, amount, commit, permitSingle, signature }), permitSingle, signature };
  }

  function buildWrapETH({ commit, amount }) {
    return { to: routerAddr(), value: BigInt(amount), calldata: wrapETHCalldata({ commit }) };
  }

  function buildSwapPublicWithPermit2({ priv, tokenIn, tokenOut, feeBps, amountIn, minAmountOut, deadline, to, permit2Nonce, expiration, sigDeadline }) {
    const { permitSingle, signature } = signPermit2Single({ token: tokenIn, amount: amountIn, expiration, nonce: permit2Nonce, sigDeadline: sigDeadline ?? deadline, priv });
    return { to: routerAddr(), value: 0n, calldata: swapPublicWithPermit2Calldata({ tokenIn, tokenOut, feeBps, amountIn, minAmountOut, deadline, to, permitSingle, signature }), permitSingle, signature };
  }

  function buildAddLiquidityPublicWithPermit2({ priv, tokenA, tokenB, feeBps, amountA, amountB, minSharesOut, deadline, to, noncesA, noncesB, expiration, sigDeadline }) {
    const details = [
      { token: tokenA, amount: amountA, expiration, nonce: noncesA },
      { token: tokenB, amount: amountB, expiration, nonce: noncesB },
    ];
    const { permitBatch, signature } = signPermit2Batch({ details, sigDeadline: sigDeadline ?? deadline, priv });
    return { to: routerAddr(), value: 0n, calldata: addLiquidityPublicWithPermit2Calldata({ tokenA, tokenB, feeBps, amountA, amountB, minSharesOut, deadline, to, permitBatch, signature }), permitBatch, signature };
  }

  return {
    PERMIT2_ADDRESS, ZROUTER_ADDRESS, routerAddr, evmAssetId,
    // EIP-712 typehashes (public constants — exposed for cross-checking vs the canonical Permit2/EIP-2612)
    typehashes: { details: PERMIT_DETAILS_TYPEHASH, single: PERMIT_SINGLE_TYPEHASH, batch: PERMIT_BATCH_TYPEHASH, erc2612: PERMIT_2612_TYPEHASH },
    // signing
    signErc2612, signPermit2Single, signPermit2Batch,
    // calldata
    wrapWithPermitCalldata, wrapWithPermit2Calldata, wrapETHCalldata,
    swapPublicWithPermitCalldata, swapPublicWithPermit2Calldata, addLiquidityPublicWithPermit2Calldata,
    // builders
    buildWrapWithPermit, buildWrapWithPermit2, buildWrapETH, buildSwapPublicWithPermit2, buildAddLiquidityPublicWithPermit2,
  };
}
