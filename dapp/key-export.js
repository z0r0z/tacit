// The keys behind a Tacit wallet's own Bitcoin and Ethereum addresses, in the forms other wallets import.
//   · Bitcoin: the wallet's address is the native segwit (P2WPKH) address of the Tacit key's compressed public key, so the Tacit key itself is the
//     Bitcoin key and only its spelling changes: a WIF (version byte, the 32 bytes, 0x01 for compressed, a 4-byte double-sha256 check, base58).
//   · Ethereum: the wallet's address is a separate key derived from the Tacit key (evm-account.js), which that file already computes.
import { sha256, base58, hexToBytes, concatBytes } from './vendor/tacit-deps.min.js';

const keyBytes = (priv) => {
  const b = typeof priv === 'string' ? hexToBytes(priv.trim().replace(/^0x/i, '')) : priv;
  if (!(b instanceof Uint8Array) || b.length !== 32) throw new Error('A key is 32 bytes.');
  return b;
};

export function wifFromPriv(priv, { testnet = false } = {}) {
  const body = concatBytes(Uint8Array.of(testnet ? 0xef : 0x80), keyBytes(priv), Uint8Array.of(1));
  return base58.encode(concatBytes(body, sha256(sha256(body)).slice(0, 4)));
}

// The key a WIF holds, read back (a check that a WIF is whole: the version, the compressed flag and the 4-byte check all agree)
export function privFromWif(wif) {
  const raw = base58.decode(String(wif).trim());
  if (raw.length !== 38) throw new Error('Not a compressed WIF.');
  const body = raw.slice(0, 34), check = raw.slice(34);
  const sum = sha256(sha256(body)).slice(0, 4);
  if (check.some((x, i) => x !== sum[i])) throw new Error('The WIF check does not match.');
  if (body[0] !== 0x80 && body[0] !== 0xef) throw new Error('Not a Bitcoin key version.');
  if (body[33] !== 1) throw new Error('Not a compressed key.');
  return body.slice(1, 33);
}
