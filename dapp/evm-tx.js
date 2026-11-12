
export function makeEvmTx({ secp, keccak256 }) {
  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
  const u8 = (...xs) => Uint8Array.of(...xs);

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

  function rlp(item) {
    if (Array.isArray(item)) {
      const payload = concat(item.map(rlp));
      return concat([encLen(payload.length, 0xc0), payload]);
    }
    if (item.length === 1 && item[0] < 0x80) return item;
    return concat([encLen(item.length, 0x80), item]);
  }

  function signEip1559(tx, priv) {
    const fields = [
      minBE(tx.chainId),
      minBE(tx.nonce),
      minBE(tx.maxPriorityFeePerGas),
      minBE(tx.maxFeePerGas),
      minBE(tx.gasLimit),
      hexToBytes(tx.to),
      minBE(tx.value || 0n),
      hexToBytes(tx.data || '0x'),
      [],
    ];
    const unsigned = concat([u8(0x02), rlp(fields)]);
    const sigHash = keccak256(unsigned);
    const sig = secp.sign(sigHash, hexToBytes(priv));
    const signed = [...fields, minBE(BigInt(sig.recovery)), minBE(sig.r), minBE(sig.s)];
    const raw = concat([u8(0x02), rlp(signed)]);
    return { raw: '0x' + bytesToHex(raw), hash: '0x' + bytesToHex(sigHash) };
  }

  return { rlp, signEip1559 };
}
