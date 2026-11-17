
export const PERMIT2_ADDRESS = '0x000000000022D473030F116dDEE9F6B43aC78BA3';
export const ZROUTER_ADDRESS = '0x000000000000FB114709235f1ccBFfb925F600e4';
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

export function makeConfidentialRouter({ secp, keccak256, sha256, cfg } = {}) {
  if (!cfg) throw new Error('makeConfidentialRouter: cfg required');
  const chainId = BigInt(cfg.chainId);
  const permit2 = String(cfg.permit2 || PERMIT2_ADDRESS).toLowerCase();
  const _router = cfg.router ? String(cfg.router).toLowerCase() : null;
  function routerAddr() {
    if (!_router) throw new Error('cfg.router not set (deploy the ConfidentialRouter, then set cfg.router)');
    return _router;
  }

  const utf8 = (s) => new TextEncoder().encode(s);
  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const concat = (...arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
  const word = (v) => {
    if (typeof v === 'bigint') return v.toString(16).padStart(64, '0');
    const s = String(v);
    return (s.startsWith('0x') ? s.slice(2) : BigInt(s).toString(16)).padStart(64, '0');
  };
  const addrWord = (a) => String(a).replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const keccakHex = (bytes) => '0x' + bytesToHex(keccak256(bytes));
  const selector = (sig) => bytesToHex(keccak256(utf8(sig)).subarray(0, 4));

  const be8 = (n) => { const o = new Uint8Array(8); let v = BigInt(n); for (let i = 7; i >= 0; i--) { o[i] = Number(v & 0xffn); v >>= 8n; } return o; };
  function evmAssetId(underlying = '0x0000000000000000000000000000000000000000') {
    const u = hexToBytes(String(underlying).replace(/^0x/, '').toLowerCase().padStart(40, '0'));
    return '0x' + bytesToHex(sha256(concat(utf8('tacit-evm-token-v1'), be8(chainId), u)));
  }

  const DOMAIN_TYPEHASH_NVCV = keccakHex(utf8('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'));
  const DOMAIN_TYPEHASH_NCV = keccakHex(utf8('EIP712Domain(string name,uint256 chainId,address verifyingContract)'));
  const PERMIT_2612_TYPEHASH = keccakHex(utf8('Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)'));
  const PERMIT_DETAILS_TYPEHASH = keccakHex(utf8('PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)'));
  const PERMIT_SINGLE_TYPEHASH = keccakHex(utf8('PermitSingle(PermitDetails details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)'));
  const PERMIT_BATCH_TYPEHASH = keccakHex(utf8('PermitBatch(PermitDetails[] details,address spender,uint256 sigDeadline)PermitDetails(address token,uint160 amount,uint48 expiration,uint48 nonce)'));

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
    const signature = '0x' + sig.r.toString(16).padStart(64, '0') + sig.s.toString(16).padStart(64, '0') + v.toString(16).padStart(2, '0');
    return { v, r, s, signature };
  }

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

  function signPermit2Single({ token, amount, expiration, nonce, sigDeadline, priv, spender }) {
    const sp = spender || routerAddr();
    const details = { token, amount: String(amount), expiration: Number(expiration), nonce: Number(nonce) };
    const sh = hashWords([PERMIT_SINGLE_TYPEHASH, detailsHash(details), aw(sp), w(BigInt(sigDeadline))]);
    const { signature } = sign712(digest712(permit2Domain(), sh), priv);
    return { permitSingle: { details, spender: sp, sigDeadline: String(sigDeadline) }, signature };
  }

  function signPermit2Batch({ details, sigDeadline, priv, spender }) {
    const sp = spender || routerAddr();
    const norm = details.map((d) => ({ token: d.token, amount: String(d.amount), expiration: Number(d.expiration), nonce: Number(d.nonce) }));
    const arrHash = keccakHex(concat(...norm.map((d) => hexToBytes(detailsHash(d)))));
    const sh = hashWords([PERMIT_BATCH_TYPEHASH, arrHash, aw(sp), w(BigInt(sigDeadline))]);
    const { signature } = sign712(digest712(permit2Domain(), sh), priv);
    return { permitBatch: { details: norm, spender: sp, sigDeadline: String(sigDeadline) }, signature };
  }

  const encPermitSingle = (ps) => addrWord(ps.details.token) + word(BigInt(ps.details.amount)) + word(BigInt(ps.details.expiration)) + word(BigInt(ps.details.nonce)) + addrWord(ps.spender) + word(BigInt(ps.sigDeadline));
  function encBytes(hex) {
    const b = String(hex || '').replace(/^0x/, '');
    const pad = (64 - (b.length % 64)) % 64;
    return word(BigInt(b.length / 2)) + b + '0'.repeat(pad);
  }
  function encPermitBatch(pb) {
    const head = word(BigInt(0x60)) + addrWord(pb.spender) + word(BigInt(pb.sigDeadline));
    let arr = word(BigInt(pb.details.length));
    for (const d of pb.details) arr += addrWord(d.token) + word(BigInt(d.amount)) + word(BigInt(d.expiration)) + word(BigInt(d.nonce));
    return head + arr;
  }
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

  function wrapWithPermitCalldata({ token, amount, commit, deadline, v, r, s }) {
    return '0x' + selector('wrapWithPermit(address,uint256,bytes32,uint256,uint8,bytes32,bytes32)')
      + addrWord(token) + word(BigInt(amount)) + word(commit) + word(BigInt(deadline)) + word(BigInt(v)) + word(r) + word(s);
  }

  function wrapWithPermit2Calldata({ token, amount, commit, permitSingle, signature }) {
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

  function wrapAndSettleWithPermitCalldata({ token, amount, commit, deadline, v, r, s, publicValues, proof, memos, feeRecipient }) {
    return '0x' + selector('wrapAndSettleWithPermit(address,uint256,bytes32,uint256,uint8,bytes32,bytes32,bytes,bytes,bytes[],address)')
      + abiArgs([
        { static: addrWord(token) }, { static: word(BigInt(amount)) }, { static: word(commit) }, { static: word(BigInt(deadline)) },
        { static: word(BigInt(v)) }, { static: word(r) }, { static: word(s) },
        { bytes: publicValues }, { bytes: proof }, { bytesArray: memos }, { static: addrWord(feeRecipient) },
      ]);
  }
  function wrapAndSettleWithPermit2Calldata({ token, amount, commit, permitSingle, signature, publicValues, proof, memos, feeRecipient }) {
    return '0x' + selector('wrapAndSettleWithPermit2(address,uint256,bytes32,((address,uint160,uint48,uint48),address,uint256),bytes,bytes,bytes,bytes[],address)')
      + abiArgs([
        { static: addrWord(token) }, { static: word(BigInt(amount)) }, { static: word(commit) }, { static: encPermitSingle(permitSingle) },
        { bytes: signature }, { bytes: publicValues }, { bytes: proof }, { bytesArray: memos }, { static: addrWord(feeRecipient) },
      ]);
  }
  function wrapAndSettleETHCalldata({ wrapAmount, commit, publicValues, proof, memos, feeRecipient }) {
    return '0x' + selector('wrapAndSettleETH(uint256,bytes32,bytes,bytes,bytes[],address)')
      + abiArgs([
        { static: word(BigInt(wrapAmount)) }, { static: word(commit) },
        { bytes: publicValues }, { bytes: proof }, { bytesArray: memos }, { static: addrWord(feeRecipient) },
      ]);
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
  // ETH → `tokenOut` on zRouter (the caller's calldata, paid to the router), then EXACTLY `wrapAmount` of it into the pool as a deposit bound to `commit`;
  // what the swap paid beyond that, and any ETH it did not spend, go back to the sender (the router's zapETHToShieldedNote; msg.value is the ETH swapped)
  function zapETHToShieldedNoteCalldata({ tokenOut, wrapAmount, commit, zrSwapData }) {
    return '0x' + selector('zapETHToShieldedNote(address,uint256,bytes32,bytes)')
      + abiArgs([{ static: addrWord(tokenOut) }, { static: word(BigInt(wrapAmount)) }, { static: word(commit) }, { bytes: zrSwapData }]);
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
  function buildZapETHToShieldedNote({ tokenOut, wrapAmount, commit, zrSwapData, amount }) {
    return { to: routerAddr(), value: BigInt(amount), calldata: zapETHToShieldedNoteCalldata({ tokenOut, wrapAmount, commit, zrSwapData }) };
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

  const PUSH0_INITCODE_PREFIX = '602d5f8160095f39f35f5f365f5f37365f73';
  const PUSH0_INITCODE_SUFFIX = '5af43d5f5f3e6029573d5ffd5b3d5ff3';
  function initCodeHashPush0(impl) {
    const i = String(impl).replace(/^0x/, '').toLowerCase().padStart(40, '0');
    return keccakHex(hexToBytes(PUSH0_INITCODE_PREFIX + i + PUSH0_INITCODE_SUFFIX));
  }

  function encExitCall(c) {
    return abiArgs([
      { static: addrWord(c.target) },
      { static: word(BigInt(c.value)) },
      { static: addrWord(c.token) },
      { static: word(BigInt(c.amount)) },
      { static: word(c.push ? 1n : 0n) },
      { bytes: c.data || '0x' },
    ]);
  }

  function encExitCallArray(items) {
    const encs = (items || []).map(encExitCall);
    let off = encs.length * 32, head = '';
    for (const e of encs) { head += word(BigInt(off)); off += e.length / 2; }
    return word(BigInt(encs.length)) + head + encs.join('');
  }

  function encUint256Array(items) {
    return word(BigInt((items || []).length)) + (items || []).map((x) => word(BigInt(x))).join('');
  }

  function encodeExitRecipe(recipe) {
    const tupleBody = abiArgs([
      { static: word(recipe.exitedAsset) },
      { static: addrWord(recipe.feeAsset) },
      { static: addrWord(recipe.finalRecipient) },
      { static: word(BigInt(recipe.deadline)) },
      { static: word(BigInt(recipe.nonce)) },
      { rawDyn: '0x' + encExitCallArray(recipe.calls) },
      { addressArray: recipe.sweepTokens || [] },
      { rawDyn: '0x' + encUint256Array(recipe.minOuts) },
    ]);
    return '0x' + word(32n) + tupleBody;
  }

  function exitRecipeSalt(recipe) {
    return keccakHex(hexToBytes(encodeExitRecipe(recipe)));
  }

  function exitRecipeEscrow(executorImpl, recipe, router) {
    const salt = exitRecipeSalt(recipe);
    const pre = concat(
      Uint8Array.of(0xff),
      hexToBytes(String(router).replace(/^0x/, '').padStart(40, '0')),
      hexToBytes(salt),
      hexToBytes(initCodeHashPush0(executorImpl)),
    );
    return '0x' + bytesToHex(keccak256(pre)).slice(24);
  }

  const EXIT_CALL_SIG = '(address,uint256,address,uint256,bool,bytes)';
  const EXIT_RECIPE_SIG = '(bytes32,address,address,uint64,uint256,' + EXIT_CALL_SIG + '[],address[],uint256[])';

  function exitAndExecuteCalldata({ publicValues, proof, memos, recipe }) {
    return '0x' + selector('exitAndExecute(bytes,bytes,bytes[],' + EXIT_RECIPE_SIG + ')')
      + abiArgs([
        { bytes: publicValues }, { bytes: proof }, { bytesArray: memos },
        { rawDyn: '0x' + encodeExitRecipe(recipe).slice(2 + 64) },
      ]);
  }

  function buildExitAndExecute({ publicValues, proof, memos, recipe }) {
    return { to: routerAddr(), value: 0n, calldata: exitAndExecuteCalldata({ publicValues, proof, memos, recipe }) };
  }

  function escrowAddressForCalldata(recipe) {
    return '0x' + selector('escrowAddressFor(' + EXIT_RECIPE_SIG + ')') + encodeExitRecipe(recipe).slice(2);
  }

  function activateExitCalldata(recipe) {
    return '0x' + selector('activateExit(' + EXIT_RECIPE_SIG + ')') + encodeExitRecipe(recipe).slice(2);
  }

  function reclaimExitCalldata(recipe, extraTokens = []) {
    return '0x' + selector('reclaimExit(' + EXIT_RECIPE_SIG + ',address[])')
      + abiArgs([
          { rawDyn: '0x' + encodeExitRecipe(recipe).slice(2 + 64) },
          { addressArray: extraTokens },
        ]);
  }

  function buildBatchExit({ exitedAsset, feeAsset = ZERO_ADDR, finalRecipient, deadline, nonce, calls, sweepTokens, minOuts }) {
    return {
      exitedAsset,
      feeAsset,
      finalRecipient,
      deadline: BigInt(deadline),
      nonce: BigInt(nonce),
      calls: (calls || []).map((c) => ({
        target: c.target,
        value: BigInt(c.value || 0),
        token: c.token || ZERO_ADDR,
        amount: BigInt(c.amount || 0),
        push: !!c.push,
        data: c.data || '0x',
      })),
      sweepTokens: sweepTokens || [],
      minOuts: (minOuts || []).map((x) => BigInt(x)),
    };
  }

  function buildSwapExit({ exitedAsset, inToken, inAmount, outToken, minOut, finalRecipient, deadline, nonce, zCalldata, push = false, feeAsset = ZERO_ADDR }) {
    return buildBatchExit({
      exitedAsset,
      feeAsset,
      finalRecipient,
      deadline,
      nonce,
      calls: [{ target: ZROUTER_ADDRESS, value: 0, token: inToken, amount: inAmount, push, data: zCalldata }],
      sweepTokens: [outToken || ZERO_ADDR],
      minOuts: [minOut],
    });
  }

  const OP_STACK_L1_BRIDGE = {
    8453: '0x3154Cf16ccdb4C6d922629664174b904d80F2C35',
  };

  function depositETHToCalldata({ l2Recipient, minGasLimit = 200000, extraData = '0x' }) {
    return '0x' + selector('depositETHTo(address,uint32,bytes)')
      + abiArgs([{ static: addrWord(l2Recipient) }, { static: word(BigInt(minGasLimit)) }, { bytes: extraData }]);
  }

  function depositERC20ToCalldata({ l1Token, l2Token, l2Recipient, amount, minGasLimit = 200000, extraData = '0x' }) {
    return '0x' + selector('depositERC20To(address,address,address,uint256,uint32,bytes)')
      + abiArgs([
        { static: addrWord(l1Token) }, { static: addrWord(l2Token) }, { static: addrWord(l2Recipient) },
        { static: word(BigInt(amount)) }, { static: word(BigInt(minGasLimit)) }, { bytes: extraData },
      ]);
  }

  function buildBridgeExit({
    exitedAsset, amount, l2Recipient, chainId = 8453, bridge, l1Token, l2Token,
    minGasLimit = 200000, finalRecipient, deadline, nonce, feeAsset = ZERO_ADDR,
  }) {
    const target = bridge || OP_STACK_L1_BRIDGE[chainId];
    if (!target) throw new Error(`no L1StandardBridge known for chainId ${chainId} — pass { bridge }`);
    if (!l2Recipient) throw new Error('l2Recipient required');
    const isEth = !l1Token || l1Token === ZERO_ADDR;
    if (!isEth && !l2Token) throw new Error('l2Token required for the ERC20 bridge path (per-chain; never defaulted)');
    const call = isEth
      ? { target, value: amount, token: ZERO_ADDR, amount: 0, push: false,
          data: depositETHToCalldata({ l2Recipient, minGasLimit }) }
      : { target, value: 0, token: l1Token, amount, push: false,
          data: depositERC20ToCalldata({ l1Token, l2Token, l2Recipient, amount, minGasLimit }) };
    return buildBatchExit({
      exitedAsset, feeAsset, finalRecipient: finalRecipient || l2Recipient,
      deadline, nonce, calls: [call], sweepTokens: [], minOuts: [],
    });
  }

  const ARBITRUM_ORBIT_INBOX = {
    4663: '0x1A07cc4BD17E0118BdB54D70990D2158AbAD7a2D',
  };

  function createRetryableTicketCalldata({
    to, l2CallValue, maxSubmissionCost, excessFeeRefundAddress, callValueRefundAddress,
    gasLimit, maxFeePerGas, data = '0x',
  }) {
    return '0x' + selector('createRetryableTicket(address,uint256,uint256,address,address,uint256,uint256,bytes)')
      + abiArgs([
          { static: addrWord(to) }, { static: word(BigInt(l2CallValue)) }, { static: word(BigInt(maxSubmissionCost)) },
          { static: addrWord(excessFeeRefundAddress) }, { static: addrWord(callValueRefundAddress) },
          { static: word(BigInt(gasLimit)) }, { static: word(BigInt(maxFeePerGas)) },
          { bytes: data },
        ]);
  }

  function buildArbitrumBridgeExit({
    exitedAsset, l2Recipient, chainId = 4663, inbox,
    l2CallValue, maxSubmissionCost, gasLimit, maxFeePerGas,
    finalRecipient, deadline, nonce, feeAsset = ZERO_ADDR,
  }) {
    const target = inbox || ARBITRUM_ORBIT_INBOX[chainId];
    if (!target) throw new Error(`no Inbox known for chainId ${chainId} — pass { inbox }`);
    if (!l2Recipient) throw new Error('l2Recipient required');
    const totalValue = BigInt(l2CallValue) + BigInt(maxSubmissionCost) + BigInt(gasLimit) * BigInt(maxFeePerGas);
    const call = {
      target, value: totalValue, token: ZERO_ADDR, amount: 0, push: false,
      data: createRetryableTicketCalldata({
        to: l2Recipient, l2CallValue, maxSubmissionCost,
        excessFeeRefundAddress: l2Recipient, callValueRefundAddress: l2Recipient,
        gasLimit, maxFeePerGas,
      }),
    };
    return buildBatchExit({
      exitedAsset, feeAsset, finalRecipient: finalRecipient || l2Recipient,
      deadline, nonce, calls: [call], sweepTokens: [ZERO_ADDR], minOuts: [0n],
    });
  }

  return {
    PERMIT2_ADDRESS, ZROUTER_ADDRESS, routerAddr, evmAssetId,
    initCodeHashPush0, encodeExitRecipe, exitRecipeSalt, exitRecipeEscrow,
    exitAndExecuteCalldata, buildExitAndExecute, buildBatchExit, buildSwapExit,
    escrowAddressForCalldata, activateExitCalldata, reclaimExitCalldata,
    OP_STACK_L1_BRIDGE, depositETHToCalldata, depositERC20ToCalldata, buildBridgeExit,
    ARBITRUM_ORBIT_INBOX, createRetryableTicketCalldata, buildArbitrumBridgeExit,
    typehashes: { details: PERMIT_DETAILS_TYPEHASH, single: PERMIT_SINGLE_TYPEHASH, batch: PERMIT_BATCH_TYPEHASH, erc2612: PERMIT_2612_TYPEHASH },
    signErc2612, signPermit2Single, signPermit2Batch, poolId,
    publicAmountOut, publicAmountInForExactOut, quotePublicPathExactOut,
    wrapWithPermitCalldata, wrapWithPermit2Calldata, wrapETHCalldata,
    swapPublicWithPermitCalldata, swapPublicWithPermit2Calldata, swapPublicETHCalldata,
    swapPublicPathWithPermit2Calldata, swapPublicETHPathCalldata,
    swapETHViaZRouterCalldata, swapTokenViaZRouterWithPermit2Calldata, addLiquidityPublicWithPermit2Calldata,
    addLiquidityPublicETHWithPermit2Calldata, removeLiquidityPublicCalldata,
    wrapAndSettleWithPermitCalldata, wrapAndSettleWithPermit2Calldata, wrapAndSettleETHCalldata, zapETHToPaymentCalldata,
    wrapAndMintCusdWithPermitCalldata, wrapAndMintCusdWithPermit2Calldata, wrapETHAndMintCusdCalldata,
    zapETHToShieldedNoteCalldata, zapETHToCanonicalNoteCalldata, zapTokenToCanonicalNoteWithPermit2Calldata,
    zapETHToCdpMintCalldata, zapTokenToCdpMintWithPermit2Calldata,
    zapETHToCanonicalCdpMintCalldata, zapTokenToCanonicalCdpMintWithPermit2Calldata,
    buildWrapWithPermit, buildWrapWithPermit2, buildWrapETH, buildSwapPublicWithPermit2, buildSwapPublicETH,
    buildSwapPublicPathWithPermit2, buildSwapPublicETHPath,
    buildSwapETHViaZRouter, buildSwapTokenViaZRouterWithPermit2, buildAddLiquidityPublicWithPermit2,
    buildAddLiquidityPublicETHWithPermit2, buildRemoveLiquidityPublic,
    buildWrapAndSettleWithPermit, buildWrapAndSettleWithPermit2, buildWrapAndSettleETH, buildZapETHToPayment,
    buildWrapAndMintCusdWithPermit, buildWrapAndMintCusdWithPermit2, buildWrapETHAndMintCusd,
    buildZapETHToShieldedNote, buildZapETHToCanonicalNote, buildZapTokenToCanonicalNoteWithPermit2,
    buildZapETHToCdpMint, buildZapTokenToCdpMintWithPermit2,
    buildZapETHToCanonicalCdpMint, buildZapTokenToCanonicalCdpMintWithPermit2,
  };
}
