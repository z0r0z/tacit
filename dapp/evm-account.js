
export function makeEvmAccount({ secp, keccak256, sha256 }) {
  const N = secp.CURVE.n;
  const utf8 = (s) => new TextEncoder().encode(s);
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const hexToBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
  const beBytes = (n, len = 32) => hexToBytes(BigInt(n).toString(16).padStart(len * 2, '0'));
  const concat = (arr) => { const t = arr.reduce((s, x) => s + x.length, 0); const o = new Uint8Array(t); let p = 0; for (const x of arr) { o.set(x, p); p += x.length; } return o; };
  const mod = (a, m) => ((a % m) + m) % m;
  const bToBig = (b) => BigInt('0x' + bytesToHex(b));
  const toPrivBytes = (p) => (p instanceof Uint8Array ? p : beBytes(BigInt(p), 32));

  function toValidScalar(bytes) {
    let s = mod(bToBig(bytes), N);
    if (s === 0n) s = mod(bToBig(sha256(concat([bytes, new Uint8Array([1])]))), N) || 1n;
    return s;
  }

  function addressFromPriv(priv) {
    const pub = secp.getPublicKey(toPrivBytes(priv), false);
    const h = keccak256(pub.slice(1));
    return '0x' + bytesToHex(h.slice(12));
  }

  function deriveEvmAccount(tacitPriv, network) {
    const tp = toPrivBytes(tacitPriv);
    const evmPriv = toValidScalar(sha256(concat([utf8('tacit-evm-account-v1'), utf8(network), tp])));
    return { priv: '0x' + evmPriv.toString(16).padStart(64, '0'), address: addressFromPriv(evmPriv) };
  }

  return { addressFromPriv, deriveEvmAccount, toValidScalar };
}
