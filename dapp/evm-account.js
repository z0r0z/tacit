// Derive an Ethereum account from a Tacit wallet — the reverse of the
// ETH→Tacit identity path. Because the Tacit wallet already holds its own
// secp256k1 key, the EVM account derives directly (no signature round-trip).
// Spec: ops/DESIGN-eth-wallet-identity.md "Reverse direction".
//
// A *dedicated, domain-separated* key (not the same scalar on both chains): for
// unlinkability (a privacy product must not link the user's ETH address to
// their BTC address) and one-wayness (a leaked EVM key reveals nothing about the
// tacit key). Network-bound, like the forward path.
//
// Crypto deps injected for Node + browser: { secp, keccak256, sha256 }.

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

  // 32 bytes → a valid secp scalar in [1, N-1], with a deterministic rehash on
  // the ~2^-128 zero/out-of-range draw (mirrors the wallet's prfBytesToScalar).
  function toValidScalar(bytes) {
    let s = mod(bToBig(bytes), N);
    if (s === 0n) s = mod(bToBig(sha256(concat([bytes, new Uint8Array([1])]))), N) || 1n;
    return s;
  }

  // EVM address = keccak256(uncompressed pubkey without the 0x04 prefix)[12:].
  function addressFromPriv(priv) {
    const pub = secp.getPublicKey(toPrivBytes(priv), false); // 65 bytes: 0x04 ‖ x ‖ y
    const h = keccak256(pub.slice(1)); // keccak of the 64-byte x‖y
    return '0x' + bytesToHex(h.slice(12)); // last 20 bytes (lowercase)
  }

  // Derive the dedicated EVM account from the tacit private key.
  // tacitPriv: bigint or 0x-hex or 32-byte; network: e.g. "mainnet" / "signet".
  function deriveEvmAccount(tacitPriv, network) {
    const tp = toPrivBytes(tacitPriv);
    const evmPriv = toValidScalar(sha256(concat([utf8('tacit-evm-account-v1'), utf8(network), tp])));
    return { priv: '0x' + evmPriv.toString(16).padStart(64, '0'), address: addressFromPriv(evmPriv) };
  }

  return { addressFromPriv, deriveEvmAccount, toValidScalar };
}
