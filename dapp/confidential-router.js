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

  function poolId(assetA, assetB, feeBps) {
    const a = String(assetA).toLowerCase();
    const b = String(assetB).toLowerCase();
    const [lo, hi] = BigInt(a) < BigInt(b) ? [a, b] : [b, a];
    return keccakHex(hexToBytes(lo.replace(/^0x/, '') + hi.replace(/^0x/, '') + word(BigInt(feeBps))));
  }

  const permit2Domain = () => hashWords([DOMAIN_TYPEHASH_NCV, keccakHex(utf8('Permit2')), w(chainId), aw(permit2)]);
  const detailsHash = (d) => hashWords([PERMIT_DETAILS_TYPEHASH, aw(d.token), w(BigInt(d.amount)), w(BigInt(d.expiration)), w(BigInt(d.nonce))]);

  const bpsDen = 10000n;
  const bi = (x) => BigInt(x);
  function publicAmountOut({ amountIn, reserveIn, reserveOut, feeBps }) {
    const ain = bi(amountIn), rin = bi(reserveIn), rout = bi(reserveOut), fee = bi(feeBps);
    if (ain <= 0n || rin <= 0n || rout <= 0n || fee >= bpsDen) throw new Error('publicAmountOut: bad amount/reserve/fee');
    const ainG = ain * (bpsDen - fee);
    return (rout * ainG) / (rin * bpsDen + ainG);
  }
  function publicAmountInForExactOut({ amountOut, reserveIn, reserveOut, feeBps }) {
    const aout = bi(amountOut), rin = bi(reserveIn), rout = bi(reserveOut), fee = bi(feeBps);
    if (aout <= 0n || rin <= 0n || rout <= 0n || fee >= bpsDen || aout >= rout) {
      throw new Error('publicAmountInForExactOut: bad amount/reserve/fee');
    }
    const num = rin * aout * bpsDen;
    const den = (rout - aout) * (bpsDen - fee);
    return num / den + 1n;
  }
  function quotePublicPathExactOut({ amountOut, hops }) {
    if (!Array.isArray(hops) || hops.length === 0) throw new Error('quotePublicPathExactOut: hops required');
    let needed = bi(amountOut);
    const reversed = [];
    for (let i = hops.length; i-- > 0;) {
      const h = hops[i];
      const amountIn = publicAmountInForExactOut({
        amountOut: needed,
        reserveIn: h.reserveIn,
        reserveOut: h.reserveOut,
        feeBps: h.feeBps,
      });
      reversed.push({ ...h, amountIn, amountOut: needed });
      needed = amountIn;
    }
    return { amountIn: needed, amountOut: bi(amountOut), hops: reversed.reverse() };
  }

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
  // bytes[] (dynamic array of dynamic bytes): count ‖ offset_i (relative to the offsets block) ‖ enc(bytes_i).
  function encBytesArray(items) {
    const encs = (items || []).map(encBytes);
    let off = encs.length * 32, head = '';
    for (const e of encs) { head += word(BigInt(off)); off += e.length / 2; }
    return word(BigInt(encs.length)) + head + encs.join('');
  }
  function encAddressArray(items) {
    return word(BigInt((items || []).length)) + (items || []).map(addrWord).join('');
  }
  function encUint32Array(items) {
    return word(BigInt((items || []).length)) + (items || []).map((x) => word(BigInt(x))).join('');
  }
  // Generic head/tail ABI assembly: static words inline, trailing dynamic params (bytes / bytes[]) as offsets +
  // blobs. parts: [{ static: '<hex, 64-char multiple>' } | { bytes: '<hex>' } | { bytesArray: ['<hex>', …] }
  // | { addressArray: ['0x...', …] } | { uint32Array: [30, …] }].
  function abiArgs(parts) {
    const headWords = parts.reduce((acc, p) => acc + (p.static != null ? p.static.length / 64 : 1), 0);
    let head = '', tail = '', tailPos = headWords * 32;
    for (const p of parts) {
      if (p.static != null) { head += p.static; continue; }
      const blob = p.rawDyn != null
        ? String(p.rawDyn).replace(/^0x/, '')
        : p.bytes != null
          ? encBytes(p.bytes)
          : p.bytesArray != null
            ? encBytesArray(p.bytesArray)
            : p.addressArray != null
              ? encAddressArray(p.addressArray)
              : encUint32Array(p.uint32Array);
      head += word(BigInt(tailPos));
      tail += blob;
      tailPos += blob.length / 2;
    }
    return head + tail;
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

  function swapPublicETHCalldata({ tokenOut, feeBps, minAmountOut, deadline, to }) {
    return '0x' + selector('swapPublicETH(address,uint32,uint256,uint64,address)')
      + addrWord(tokenOut) + word(BigInt(feeBps)) + word(BigInt(minAmountOut)) + word(BigInt(deadline)) + addrWord(to);
  }

  function swapPublicPathWithPermit2Calldata({ path, fees, amountIn, minAmountOut, deadline, to, permitSingle, signature }) {
    return '0x' + selector('swapPublicPathWithPermit2(address[],uint32[],uint256,uint256,uint64,address,((address,uint160,uint48,uint48),address,uint256),bytes)')
      + abiArgs([
        { addressArray: path }, { uint32Array: fees }, { static: word(BigInt(amountIn)) }, { static: word(BigInt(minAmountOut)) },
        { static: word(BigInt(deadline)) }, { static: addrWord(to) }, { static: encPermitSingle(permitSingle) }, { bytes: signature },
      ]);
  }

  function swapPublicETHPathCalldata({ path, fees, minAmountOut, deadline, to }) {
    return '0x' + selector('swapPublicETHPath(address[],uint32[],uint256,uint64,address)')
      + abiArgs([
        { addressArray: path }, { uint32Array: fees }, { static: word(BigInt(minAmountOut)) },
        { static: word(BigInt(deadline)) }, { static: addrWord(to) },
      ]);
  }

  function swapPublicExactOutWithPermit2Calldata({ tokenOut, feeBps, amountOut, maxAmountIn, deadline, to, permitSingle, signature }) {
    return '0x' + selector('swapPublicExactOutWithPermit2(address,uint32,uint256,uint256,uint64,address,((address,uint160,uint48,uint48),address,uint256),bytes)')
      + abiArgs([
        { static: addrWord(tokenOut) }, { static: word(BigInt(feeBps)) }, { static: word(BigInt(amountOut)) },
        { static: word(BigInt(maxAmountIn)) }, { static: word(BigInt(deadline)) }, { static: addrWord(to) },
        { static: encPermitSingle(permitSingle) }, { bytes: signature },
      ]);
  }

  function swapPublicETHExactOutCalldata({ tokenOut, feeBps, amountOut, deadline, to }) {
    return '0x' + selector('swapPublicETHExactOut(address,uint32,uint256,uint64,address)')
      + addrWord(tokenOut) + word(BigInt(feeBps)) + word(BigInt(amountOut)) + word(BigInt(deadline)) + addrWord(to);
  }

  function swapPublicPathExactOutWithPermit2Calldata({ path, fees, amountOut, maxAmountIn, deadline, to, permitSingle, signature }) {
    return '0x' + selector('swapPublicPathExactOutWithPermit2(address[],uint32[],uint256,uint256,uint64,address,((address,uint160,uint48,uint48),address,uint256),bytes)')
      + abiArgs([
        { addressArray: path }, { uint32Array: fees }, { static: word(BigInt(amountOut)) }, { static: word(BigInt(maxAmountIn)) },
        { static: word(BigInt(deadline)) }, { static: addrWord(to) }, { static: encPermitSingle(permitSingle) }, { bytes: signature },
      ]);
  }

  function swapPublicETHPathExactOutCalldata({ path, fees, amountOut, deadline, to }) {
    return '0x' + selector('swapPublicETHPathExactOut(address[],uint32[],uint256,uint64,address)')
      + abiArgs([
        { addressArray: path }, { uint32Array: fees }, { static: word(BigInt(amountOut)) },
        { static: word(BigInt(deadline)) }, { static: addrWord(to) },
      ]);
  }

  function swapETHViaZRouterCalldata({ tokenOut, minAmountOut, to, zrSwapData }) {
    return '0x' + selector('swapETHViaZRouter(address,uint256,address,bytes)')
      + abiArgs([{ static: addrWord(tokenOut) }, { static: word(BigInt(minAmountOut)) }, { static: addrWord(to) }, { bytes: zrSwapData }]);
  }

  function swapTokenViaZRouterWithPermit2Calldata({ tokenOut, amountIn, minAmountOut, to, permitSingle, signature, zrSwapData }) {
    return '0x' + selector('swapTokenViaZRouterWithPermit2(address,uint256,uint256,address,((address,uint160,uint48,uint48),address,uint256),bytes,bytes)')
      + abiArgs([
        { static: addrWord(tokenOut) }, { static: word(BigInt(amountIn)) }, { static: word(BigInt(minAmountOut)) },
        { static: addrWord(to) }, { static: encPermitSingle(permitSingle) }, { bytes: signature }, { bytes: zrSwapData },
      ]);
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

  function addLiquidityPublicETHWithPermit2Calldata({ token, feeBps, tokenAmount, minSharesOut, deadline, to, permitSingle, signature }) {
    return '0x' + selector('addLiquidityPublicETHWithPermit2(address,uint32,uint256,uint256,uint64,address,((address,uint160,uint48,uint48),address,uint256),bytes)')
      + abiArgs([
        { static: addrWord(token) }, { static: word(BigInt(feeBps)) }, { static: word(BigInt(tokenAmount)) },
        { static: word(BigInt(minSharesOut)) }, { static: word(BigInt(deadline)) }, { static: addrWord(to) },
        { static: encPermitSingle(permitSingle) }, { bytes: signature },
      ]);
  }

  function removeLiquidityPublicCalldata({ tokenA, tokenB, feeBps, shares, minAmountA, minAmountB, deadline, to }) {
    return '0x' + selector('removeLiquidityPublic(address,address,uint32,uint256,uint256,uint256,uint64,address)')
      + addrWord(tokenA) + addrWord(tokenB) + word(BigInt(feeBps)) + word(BigInt(shares)) + word(BigInt(minAmountA))
      + word(BigInt(minAmountB)) + word(BigInt(deadline)) + addrWord(to);
  }

  // ── Atomic-settle calldata: the router embeds a box prove-only proof (publicValues, proof, memos[]) ──
  function wrapAndSettleWithPermitCalldata({ token, amount, commit, deadline, v, r, s, publicValues, proof, memos }) {
    return '0x' + selector('wrapAndSettleWithPermit(address,uint256,bytes32,uint256,uint8,bytes32,bytes32,bytes,bytes,bytes[])')
      + abiArgs([
        { static: addrWord(token) }, { static: word(BigInt(amount)) }, { static: word(commit) }, { static: word(BigInt(deadline)) },
        { static: word(BigInt(v)) }, { static: word(r) }, { static: word(s) },
        { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
      ]);
  }
  function wrapAndSettleWithPermit2Calldata({ token, amount, commit, permitSingle, signature, publicValues, proof, memos }) {
    return '0x' + selector('wrapAndSettleWithPermit2(address,uint256,bytes32,((address,uint160,uint48,uint48),address,uint256),bytes,bytes,bytes,bytes[])')
      + abiArgs([
        { static: addrWord(token) }, { static: word(BigInt(amount)) }, { static: word(commit) }, { static: encPermitSingle(permitSingle) },
        { bytes: signature }, { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
      ]);
  }
  function wrapAndSettleETHCalldata({ commit, publicValues, proof, memos }) {
    return '0x' + selector('wrapAndSettleETH(bytes32,bytes,bytes,bytes[])')
      + abiArgs([{ static: word(commit) }, { bytes: publicValues }, { bytes: proof }, { bytesArray: memos }]);
  }
  function wrapAndMintCusdWithPermitCalldata({ token, amount, commit, deadline, v, r, s, publicValues, proof, memos }) {
    return '0x' + selector('wrapAndMintCusdWithPermit(address,uint256,bytes32,uint256,uint8,bytes32,bytes32,bytes,bytes,bytes[])')
      + abiArgs([
        { static: addrWord(token) }, { static: word(BigInt(amount)) }, { static: word(commit) }, { static: word(BigInt(deadline)) },
        { static: word(BigInt(v)) }, { static: word(r) }, { static: word(s) },
        { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
      ]);
  }
  function wrapAndMintCusdWithPermit2Calldata({ token, amount, commit, permitSingle, signature, publicValues, proof, memos }) {
    return '0x' + selector('wrapAndMintCusdWithPermit2(address,uint256,bytes32,((address,uint160,uint48,uint48),address,uint256),bytes,bytes,bytes,bytes[])')
      + abiArgs([
        { static: addrWord(token) }, { static: word(BigInt(amount)) }, { static: word(commit) }, { static: encPermitSingle(permitSingle) },
        { bytes: signature }, { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
      ]);
  }
  function wrapETHAndMintCusdCalldata({ commit, publicValues, proof, memos }) {
    return '0x' + selector('wrapETHAndMintCusd(bytes32,bytes,bytes,bytes[])')
      + abiArgs([{ static: word(commit) }, { bytes: publicValues }, { bytes: proof }, { bytesArray: memos }]);
  }
  function zapETHToPaymentCalldata({ tokenOut, wrapAmount, commit, zrSwapData, publicValues, proof, memos }) {
    return '0x' + selector('zapETHToPayment(address,uint256,bytes32,bytes,bytes,bytes,bytes[])')
      + abiArgs([
        { static: addrWord(tokenOut) }, { static: word(BigInt(wrapAmount)) }, { static: word(commit) },
        { bytes: zrSwapData }, { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
      ]);
  }
  function zapETHToCanonicalNoteCalldata({ assetId, wrapAmount, commit, zrSwapData }) {
    return '0x' + selector('zapETHToCanonicalNote(bytes32,uint256,bytes32,bytes)')
      + abiArgs([{ static: word(assetId) }, { static: word(BigInt(wrapAmount)) }, { static: word(commit) }, { bytes: zrSwapData }]);
  }
  function zapTokenToCanonicalNoteWithPermit2Calldata({ assetId, amountIn, wrapAmount, commit, permitSingle, signature, zrSwapData }) {
    return '0x' + selector('zapTokenToCanonicalNoteWithPermit2(bytes32,uint256,uint256,bytes32,((address,uint160,uint48,uint48),address,uint256),bytes,bytes)')
      + abiArgs([
        { static: word(assetId) }, { static: word(BigInt(amountIn)) }, { static: word(BigInt(wrapAmount)) },
        { static: word(commit) }, { static: encPermitSingle(permitSingle) }, { bytes: signature }, { bytes: zrSwapData },
      ]);
  }
  function zapETHToCdpMintCalldata({ tokenOut, wrapAmount, commit, zrSwapData, publicValues, proof, memos }) {
    return '0x' + selector('zapETHToCdpMint(address,uint256,bytes32,bytes,bytes,bytes,bytes[])')
      + abiArgs([
        { static: addrWord(tokenOut) }, { static: word(BigInt(wrapAmount)) }, { static: word(commit) },
        { bytes: zrSwapData }, { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
      ]);
  }
  function zapTokenToCdpMintWithPermit2Calldata({ tokenOut, amountIn, wrapAmount, commit, permitSingle, signature, zrSwapData, publicValues, proof, memos }) {
    return '0x' + selector('zapTokenToCdpMintWithPermit2(address,uint256,uint256,bytes32,((address,uint160,uint48,uint48),address,uint256),bytes,bytes,bytes,bytes,bytes[])')
      + abiArgs([
        { static: addrWord(tokenOut) }, { static: word(BigInt(amountIn)) }, { static: word(BigInt(wrapAmount)) },
        { static: word(commit) }, { static: encPermitSingle(permitSingle) }, { bytes: signature }, { bytes: zrSwapData },
        { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
      ]);
  }
  function zapETHToCanonicalCdpMintCalldata({ assetId, wrapAmount, commit, zrSwapData, publicValues, proof, memos }) {
    return '0x' + selector('zapETHToCanonicalCdpMint(bytes32,uint256,bytes32,bytes,bytes,bytes,bytes[])')
      + abiArgs([
        { static: word(assetId) }, { static: word(BigInt(wrapAmount)) }, { static: word(commit) },
        { bytes: zrSwapData }, { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
      ]);
  }
  function zapTokenToCanonicalCdpMintWithPermit2Calldata({ assetId, amountIn, wrapAmount, commit, permitSingle, signature, zrSwapData, publicValues, proof, memos }) {
    return '0x' + selector('zapTokenToCanonicalCdpMintWithPermit2(bytes32,uint256,uint256,bytes32,((address,uint160,uint48,uint48),address,uint256),bytes,bytes,bytes,bytes,bytes[])')
      + abiArgs([
        { static: word(assetId) }, { static: word(BigInt(amountIn)) }, { static: word(BigInt(wrapAmount)) },
        { static: word(commit) }, { static: encPermitSingle(permitSingle) }, { bytes: signature }, { bytes: zrSwapData },
        { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
      ]);
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

  function buildSwapPublicETH({ tokenOut, amountIn, feeBps, minAmountOut, deadline, to }) {
    return { to: routerAddr(), value: BigInt(amountIn), calldata: swapPublicETHCalldata({ tokenOut, feeBps, minAmountOut, deadline, to }) };
  }

  function buildSwapPublicPathWithPermit2({ priv, tokenIn, path, fees, amountIn, minAmountOut, deadline, to, permit2Nonce, expiration, sigDeadline }) {
    const { permitSingle, signature } = signPermit2Single({ token: tokenIn, amount: amountIn, expiration, nonce: permit2Nonce, sigDeadline: sigDeadline ?? deadline, priv });
    return {
      to: routerAddr(),
      value: 0n,
      calldata: swapPublicPathWithPermit2Calldata({ path, fees, amountIn, minAmountOut, deadline, to, permitSingle, signature }),
      permitSingle,
      signature,
    };
  }

  function buildSwapPublicETHPath({ path, fees, amountIn, minAmountOut, deadline, to }) {
    return { to: routerAddr(), value: BigInt(amountIn), calldata: swapPublicETHPathCalldata({ path, fees, minAmountOut, deadline, to }) };
  }

  function buildSwapPublicExactOutWithPermit2({ priv, tokenIn, tokenOut, feeBps, amountOut, maxAmountIn, deadline, to, permit2Nonce, expiration, sigDeadline }) {
    const { permitSingle, signature } = signPermit2Single({ token: tokenIn, amount: maxAmountIn, expiration, nonce: permit2Nonce, sigDeadline: sigDeadline ?? deadline, priv });
    return {
      to: routerAddr(),
      value: 0n,
      calldata: swapPublicExactOutWithPermit2Calldata({ tokenOut, feeBps, amountOut, maxAmountIn, deadline, to, permitSingle, signature }),
      permitSingle,
      signature,
    };
  }

  function buildSwapPublicETHExactOut({ tokenOut, maxAmountIn, feeBps, amountOut, deadline, to }) {
    return { to: routerAddr(), value: BigInt(maxAmountIn), calldata: swapPublicETHExactOutCalldata({ tokenOut, feeBps, amountOut, deadline, to }) };
  }

  function buildSwapPublicPathExactOutWithPermit2({ priv, tokenIn, path, fees, amountOut, maxAmountIn, deadline, to, permit2Nonce, expiration, sigDeadline }) {
    const { permitSingle, signature } = signPermit2Single({ token: tokenIn, amount: maxAmountIn, expiration, nonce: permit2Nonce, sigDeadline: sigDeadline ?? deadline, priv });
    return {
      to: routerAddr(),
      value: 0n,
      calldata: swapPublicPathExactOutWithPermit2Calldata({ path, fees, amountOut, maxAmountIn, deadline, to, permitSingle, signature }),
      permitSingle,
      signature,
    };
  }

  function buildSwapPublicETHPathExactOut({ path, fees, maxAmountIn, amountOut, deadline, to }) {
    return { to: routerAddr(), value: BigInt(maxAmountIn), calldata: swapPublicETHPathExactOutCalldata({ path, fees, amountOut, deadline, to }) };
  }

  function buildSwapETHViaZRouter({ tokenOut, amountIn, minAmountOut, to, zrSwapData }) {
    return { to: routerAddr(), value: BigInt(amountIn), calldata: swapETHViaZRouterCalldata({ tokenOut, minAmountOut, to, zrSwapData }) };
  }

  function buildSwapTokenViaZRouterWithPermit2({ priv, tokenIn, tokenOut, amountIn, minAmountOut, to, permit2Nonce, expiration, sigDeadline, zrSwapData }) {
    const { permitSingle, signature } = signPermit2Single({ token: tokenIn, amount: amountIn, expiration, nonce: permit2Nonce, sigDeadline, priv });
    return {
      to: routerAddr(),
      value: 0n,
      calldata: swapTokenViaZRouterWithPermit2Calldata({ tokenOut, amountIn, minAmountOut, to, permitSingle, signature, zrSwapData }),
      permitSingle,
      signature,
    };
  }

  function buildAddLiquidityPublicWithPermit2({ priv, tokenA, tokenB, feeBps, amountA, amountB, minSharesOut, deadline, to, noncesA, noncesB, expiration, sigDeadline }) {
    const details = [
      { token: tokenA, amount: amountA, expiration, nonce: noncesA },
      { token: tokenB, amount: amountB, expiration, nonce: noncesB },
    ];
    const { permitBatch, signature } = signPermit2Batch({ details, sigDeadline: sigDeadline ?? deadline, priv });
    return { to: routerAddr(), value: 0n, calldata: addLiquidityPublicWithPermit2Calldata({ tokenA, tokenB, feeBps, amountA, amountB, minSharesOut, deadline, to, permitBatch, signature }), permitBatch, signature };
  }

  function buildAddLiquidityPublicETHWithPermit2({ priv, token, ethAmount, tokenAmount, feeBps, minSharesOut, deadline, to, permit2Nonce, expiration, sigDeadline }) {
    const { permitSingle, signature } = signPermit2Single({ token, amount: tokenAmount, expiration, nonce: permit2Nonce, sigDeadline: sigDeadline ?? deadline, priv });
    return {
      to: routerAddr(),
      value: BigInt(ethAmount),
      calldata: addLiquidityPublicETHWithPermit2Calldata({ token, feeBps, tokenAmount, minSharesOut, deadline, to, permitSingle, signature }),
      permitSingle,
      signature,
    };
  }

  function buildRemoveLiquidityPublic({ tokenA, tokenB, feeBps, shares, minAmountA, minAmountB, deadline, to }) {
    return { to: routerAddr(), value: 0n, calldata: removeLiquidityPublicCalldata({ tokenA, tokenB, feeBps, shares, minAmountA, minAmountB, deadline, to }) };
  }

  // ── Atomic-settle builders: caller supplies the box prove-only artifacts { publicValues, proof, memos }
  //    (from relay.prove(...)) + the wrap/permit/zap inputs → { to, value, calldata } for the user's tx ──
  function buildWrapAndSettleETH({ commit, amount, publicValues, proof, memos }) {
    return { to: routerAddr(), value: BigInt(amount), calldata: wrapAndSettleETHCalldata({ commit, publicValues, proof, memos }) };
  }
  function buildWrapAndSettleWithPermit({ priv, owner, token, name, version, amount, commit, tokenNonce, deadline, publicValues, proof, memos }) {
    const sig = signErc2612({ token, name, version, owner, value: amount, nonce: tokenNonce, deadline, priv });
    return { to: routerAddr(), value: 0n, calldata: wrapAndSettleWithPermitCalldata({ token, amount, commit, deadline, v: sig.v, r: sig.r, s: sig.s, publicValues, proof, memos }), permitSig: sig };
  }
  function buildWrapAndSettleWithPermit2({ priv, token, amount, commit, permit2Nonce, expiration, sigDeadline, publicValues, proof, memos }) {
    const { permitSingle, signature } = signPermit2Single({ token, amount, expiration, nonce: permit2Nonce, sigDeadline, priv });
    return { to: routerAddr(), value: 0n, calldata: wrapAndSettleWithPermit2Calldata({ token, amount, commit, permitSingle, signature, publicValues, proof, memos }), permitSingle, signature };
  }
  function buildWrapAndMintCusdWithPermit({ priv, owner, token, name, version, amount, commit, tokenNonce, deadline, publicValues, proof, memos }) {
    const sig = signErc2612({ token, name, version, owner, value: amount, nonce: tokenNonce, deadline, priv });
    return { to: routerAddr(), value: 0n, calldata: wrapAndMintCusdWithPermitCalldata({ token, amount, commit, deadline, v: sig.v, r: sig.r, s: sig.s, publicValues, proof, memos }), permitSig: sig };
  }
  function buildWrapAndMintCusdWithPermit2({ priv, token, amount, commit, permit2Nonce, expiration, sigDeadline, publicValues, proof, memos }) {
    const { permitSingle, signature } = signPermit2Single({ token, amount, expiration, nonce: permit2Nonce, sigDeadline, priv });
    return { to: routerAddr(), value: 0n, calldata: wrapAndMintCusdWithPermit2Calldata({ token, amount, commit, permitSingle, signature, publicValues, proof, memos }), permitSingle, signature };
  }
  function buildWrapETHAndMintCusd({ commit, amount, publicValues, proof, memos }) {
    return { to: routerAddr(), value: BigInt(amount), calldata: wrapETHAndMintCusdCalldata({ commit, publicValues, proof, memos }) };
  }
  function buildZapETHToPayment({ tokenOut, wrapAmount, commit, zrSwapData, amount, publicValues, proof, memos }) {
    return { to: routerAddr(), value: BigInt(amount), calldata: zapETHToPaymentCalldata({ tokenOut, wrapAmount, commit, zrSwapData, publicValues, proof, memos }) };
  }
  function buildZapETHToCanonicalNote({ assetId, wrapAmount, commit, zrSwapData, amount }) {
    return { to: routerAddr(), value: BigInt(amount), calldata: zapETHToCanonicalNoteCalldata({ assetId, wrapAmount, commit, zrSwapData }) };
  }
  function buildZapTokenToCanonicalNoteWithPermit2({ priv, tokenIn, assetId, amountIn, wrapAmount, commit, permit2Nonce, expiration, sigDeadline, zrSwapData }) {
    const { permitSingle, signature } = signPermit2Single({ token: tokenIn, amount: amountIn, expiration, nonce: permit2Nonce, sigDeadline, priv });
    return {
      to: routerAddr(),
      value: 0n,
      calldata: zapTokenToCanonicalNoteWithPermit2Calldata({ assetId, amountIn, wrapAmount, commit, permitSingle, signature, zrSwapData }),
      permitSingle,
      signature,
    };
  }
  function buildZapETHToCdpMint({ tokenOut, wrapAmount, commit, zrSwapData, amount, publicValues, proof, memos }) {
    return { to: routerAddr(), value: BigInt(amount), calldata: zapETHToCdpMintCalldata({ tokenOut, wrapAmount, commit, zrSwapData, publicValues, proof, memos }) };
  }
  function buildZapTokenToCdpMintWithPermit2({ priv, tokenIn, tokenOut, amountIn, wrapAmount, commit, permit2Nonce, expiration, sigDeadline, zrSwapData, publicValues, proof, memos }) {
    const { permitSingle, signature } = signPermit2Single({ token: tokenIn, amount: amountIn, expiration, nonce: permit2Nonce, sigDeadline, priv });
    return {
      to: routerAddr(),
      value: 0n,
      calldata: zapTokenToCdpMintWithPermit2Calldata({ tokenOut, amountIn, wrapAmount, commit, permitSingle, signature, zrSwapData, publicValues, proof, memos }),
      permitSingle,
      signature,
    };
  }
  function buildZapETHToCanonicalCdpMint({ assetId, wrapAmount, commit, zrSwapData, amount, publicValues, proof, memos }) {
    return { to: routerAddr(), value: BigInt(amount), calldata: zapETHToCanonicalCdpMintCalldata({ assetId, wrapAmount, commit, zrSwapData, publicValues, proof, memos }) };
  }
  function buildZapTokenToCanonicalCdpMintWithPermit2({ priv, tokenIn, assetId, amountIn, wrapAmount, commit, permit2Nonce, expiration, sigDeadline, zrSwapData, publicValues, proof, memos }) {
    const { permitSingle, signature } = signPermit2Single({ token: tokenIn, amount: amountIn, expiration, nonce: permit2Nonce, sigDeadline, priv });
    return {
      to: routerAddr(),
      value: 0n,
      calldata: zapTokenToCanonicalCdpMintWithPermit2Calldata({ assetId, amountIn, wrapAmount, commit, permitSingle, signature, zrSwapData, publicValues, proof, memos }),
      permitSingle,
      signature,
    };
  }

  // ── Exit-and-call: shielded exit → pinned zRouter, atomically bound by the recipe-hash CREATE2 escrow ──
  //
  // The router unwraps `exitedAsset` TO escrowAddressFor(recipe) — a CREATE2 address keyed by keccak(abi.encode
  // (recipe)) — so the settle PROOF commits the whole recipe via its withdrawal `recipient`. A front-runner can't
  // redirect the output or alter the route without changing that address; the honest caller's funds are already
  // in their escrow, so a tampered call reverts on an empty escrow.
  //
  // RECIPE-BUILDER USAGE:
  //   1. const escrow = exitRecipeEscrow(cfg.router, recipe);
  //   2. build the settle proof so its withdrawals[0] = { assetId: recipe.exitedAsset, value, recipient: escrow };
  //   3. send exitAndCallCalldata({ publicValues, proof, memos, recipe }) to the router.

  // keccak of the empty-constructor ExitEscrow creation code — the ONLY initcode the router CREATE2s. Mirror of
  // ConfidentialRouter.EXIT_ESCROW_INITCODE_HASH. RE-DERIVE if ExitEscrow changes:
  //   forge inspect ExitEscrow bytecode | cast keccak  (== keccak256(type(ExitEscrow).creationCode))
  const EXIT_ESCROW_INITCODE_HASH = '0xe6d8d739de13b5016e66ce90c2c628dbf3083375504cd9d9937415be0e8c67a2';

  // Solidity abi.encode of the ExitRecipe tuple
  //   (bytes32 exitedAsset, address tokenOut, uint256 minOut, address finalRecipient, uint64 deadline,
  //    uint256 nonce, bytes zCalldata)
  // The recipe is a DYNAMIC tuple (it holds `bytes`), so the top-level abi.encode prepends a 0x20 offset word,
  // then the tuple body: 6 static head words + the dynamic `bytes` placed in the tail (head carries its offset).
  function encodeExitRecipe(recipe) {
    const tupleBody = abiArgs([
      { static: word(recipe.exitedAsset) },
      { static: addrWord(recipe.tokenOut) },
      { static: word(BigInt(recipe.minOut)) },
      { static: addrWord(recipe.finalRecipient) },
      { static: word(BigInt(recipe.deadline)) },
      { static: word(BigInt(recipe.nonce)) },
      { bytes: recipe.zCalldata },
    ]);
    return '0x' + word(32n) + tupleBody; // leading offset word for the top-level dynamic tuple
  }

  // keccak256(abi.encode(recipe)) — the CREATE2 salt the contract uses.
  function exitRecipeSalt(recipe) {
    return keccakHex(hexToBytes(encodeExitRecipe(recipe)));
  }

  // The deterministic escrow address the proof MUST pay (byte-identical to router.escrowAddressFor(recipe)):
  //   keccak256(0xff ++ router ++ salt ++ EXIT_ESCROW_INITCODE_HASH)[12:].
  function exitRecipeEscrow(router, recipe) {
    const salt = exitRecipeSalt(recipe);
    const pre = concat(
      Uint8Array.of(0xff),
      hexToBytes(String(router).replace(/^0x/, '').padStart(40, '0')),
      hexToBytes(salt),
      hexToBytes(EXIT_ESCROW_INITCODE_HASH),
    );
    return '0x' + bytesToHex(keccak256(pre)).slice(24); // low 20 bytes
  }

  // exitAndCall(bytes publicValues, bytes proofBytes, bytes[] memos, ExitRecipe recipe). The recipe is encoded
  // inline as a dynamic tuple (offset in the head, body in the tail) so it matches the Solidity selector args.
  function exitAndCallCalldata({ publicValues, proof, memos, recipe }) {
    return '0x' + selector('exitAndCall(bytes,bytes,bytes[],(bytes32,address,uint256,address,uint64,uint256,bytes))')
      + abiArgs([
        { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
        // The recipe tuple body WITHOUT the top-level offset word (abiArgs places the tuple's own offset in
        // the head); encodeExitRecipe returns `0x20 ‖ body`, so drop the leading 32-byte offset word.
        { rawDyn: '0x' + encodeExitRecipe(recipe).slice(2 + 64) },
      ]);
  }

  function buildExitAndCall({ publicValues, proof, memos, recipe }) {
    return { to: routerAddr(), value: 0n, calldata: exitAndCallCalldata({ publicValues, proof, memos, recipe }) };
  }

  return {
    PERMIT2_ADDRESS, ZROUTER_ADDRESS, routerAddr, evmAssetId,
    // exit-and-call (recipe-bound CREATE2 escrow)
    EXIT_ESCROW_INITCODE_HASH, encodeExitRecipe, exitRecipeSalt, exitRecipeEscrow,
    exitAndCallCalldata, buildExitAndCall,
    // EIP-712 typehashes (public constants — exposed for cross-checking vs the canonical Permit2/EIP-2612)
    typehashes: { details: PERMIT_DETAILS_TYPEHASH, single: PERMIT_SINGLE_TYPEHASH, batch: PERMIT_BATCH_TYPEHASH, erc2612: PERMIT_2612_TYPEHASH },
    // signing
    signErc2612, signPermit2Single, signPermit2Batch, poolId,
    // public AMM quoting helpers (pure; reserve snapshots come from pool.pools(poolId) / indexer)
    publicAmountOut, publicAmountInForExactOut, quotePublicPathExactOut,
    // calldata (proof-free)
    wrapWithPermitCalldata, wrapWithPermit2Calldata, wrapETHCalldata,
    swapPublicWithPermitCalldata, swapPublicWithPermit2Calldata, swapPublicETHCalldata,
    swapPublicPathWithPermit2Calldata, swapPublicETHPathCalldata,
    swapPublicExactOutWithPermit2Calldata, swapPublicETHExactOutCalldata,
    swapPublicPathExactOutWithPermit2Calldata, swapPublicETHPathExactOutCalldata,
    swapETHViaZRouterCalldata, swapTokenViaZRouterWithPermit2Calldata, addLiquidityPublicWithPermit2Calldata,
    addLiquidityPublicETHWithPermit2Calldata, removeLiquidityPublicCalldata,
    // calldata (atomic-settle: embeds a box prove-only proof)
    wrapAndSettleWithPermitCalldata, wrapAndSettleWithPermit2Calldata, wrapAndSettleETHCalldata, zapETHToPaymentCalldata,
    wrapAndMintCusdWithPermitCalldata, wrapAndMintCusdWithPermit2Calldata, wrapETHAndMintCusdCalldata,
    zapETHToCanonicalNoteCalldata, zapTokenToCanonicalNoteWithPermit2Calldata,
    zapETHToCdpMintCalldata, zapTokenToCdpMintWithPermit2Calldata,
    zapETHToCanonicalCdpMintCalldata, zapTokenToCanonicalCdpMintWithPermit2Calldata,
    // builders
    buildWrapWithPermit, buildWrapWithPermit2, buildWrapETH, buildSwapPublicWithPermit2, buildSwapPublicETH,
    buildSwapPublicPathWithPermit2, buildSwapPublicETHPath,
    buildSwapPublicExactOutWithPermit2, buildSwapPublicETHExactOut,
    buildSwapPublicPathExactOutWithPermit2, buildSwapPublicETHPathExactOut,
    buildSwapETHViaZRouter, buildSwapTokenViaZRouterWithPermit2, buildAddLiquidityPublicWithPermit2,
    buildAddLiquidityPublicETHWithPermit2, buildRemoveLiquidityPublic,
    buildWrapAndSettleWithPermit, buildWrapAndSettleWithPermit2, buildWrapAndSettleETH, buildZapETHToPayment,
    buildWrapAndMintCusdWithPermit, buildWrapAndMintCusdWithPermit2, buildWrapETHAndMintCusd,
    buildZapETHToCanonicalNote, buildZapTokenToCanonicalNoteWithPermit2,
    buildZapETHToCdpMint, buildZapTokenToCdpMintWithPermit2,
    buildZapETHToCanonicalCdpMint, buildZapTokenToCanonicalCdpMintWithPermit2,
  };
}
