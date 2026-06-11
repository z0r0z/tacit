// In-wallet EVM signer: build + sign EIP-1559 (type-2) transactions from the
// Tacit-derived secp key, so a Bitcoin-first user submits wrap / unwrap / settle
// on Ethereum with no external wallet. Pairs with dapp/evm-account.js (key +
// address derivation). Deps injected: { secp, keccak256 }.
//
// EIP-1559 signing payload: 0x02 ‖ rlp([chainId, nonce, maxPriorityFeePerGas,
// maxFeePerGas, gasLimit, to, value, data, accessList]); sign keccak256 of it;
// signed tx appends [yParity, r, s].

export function makeEvmTx({ secp, keccak256 }) {
  const hexToBytes = (h) => Uint8Array.from(Buffer.from(String(h).replace(/^0x/, ''), 'hex'));
  const bytesToHex = (b) => Buffer.from(b).toString('hex');
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
  const u8 = (...xs) => Uint8Array.of(...xs);

  // minimal big-endian bytes of a non-negative integer (empty for 0) — RLP quantity.
  const minBE = (n) => {
    n = BigInt(n);
    if (n === 0n) return new Uint8Array(0);
    let h = n.toString(16);
    if (h.length & 1) h = '0' + h;
    return hexToBytes(h);
  };

  function encLen(len, offset) {
    if (len < 56) return u8(offset + len);
    const lb = minBE(BigInt(len));
    return concat([u8(offset + 55 + lb.length), lb]);
  }

  // RLP: arrays → lists, Uint8Array → byte strings.
  function rlp(item) {
    if (Array.isArray(item)) {
      const payload = concat(item.map(rlp));
      return concat([encLen(payload.length, 0xc0), payload]);
    }
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat([encLen(item.length, 0x80), item]);
  }

  // tx: { chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data }
  // (integers as bigint/number/0x-hex; to as 0x-address; data as 0x-bytes).
  function signEip1559(tx, priv) {
    const fields = [
      minBE(tx.chainId),
      minBE(tx.nonce),
      minBE(tx.maxPriorityFeePerGas),
      minBE(tx.maxFeePerGas),
      minBE(tx.gasLimit),
      hexToBytes(tx.to), // 20-byte address
      minBE(tx.value || 0n),
      hexToBytes(tx.data || '0x'),
      [], // empty accessList
    ];
    const unsigned = concat([u8(0x02), rlp(fields)]);
    const sigHash = keccak256(unsigned);
    const sig = secp.sign(sigHash, hexToBytes(priv)); // RFC 6979 deterministic, low-s
    const signed = [...fields, minBE(BigInt(sig.recovery)), minBE(sig.r), minBE(sig.s)];
    const raw = concat([u8(0x02), rlp(signed)]);
    return { raw: '0x' + bytesToHex(raw), hash: '0x' + bytesToHex(sigHash) };
  }

  return { rlp, signEip1559 };
}
