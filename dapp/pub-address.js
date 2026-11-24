// The Bitcoin address a Tacit key holds its TAC at (its native segwit one, bc1q…), made from the public key alone. An Activity entry keeps only the
// public key of the wallet that made it, so this is how a row made by another wallet is named: it is the address Bitcoin's explorers show.
import { sha256, ripemd160, bech32, hexToBytes } from './vendor/tacit-deps.min.js';

const PUB = /^0[23][0-9a-f]{64}$/;
export const pubHexOf = (v) => { const h = String(v ?? '').trim().toLowerCase().replace(/^0x/, ''); return PUB.test(h) ? h : null; };

export function btcAddressOf(pub, hrp = 'bc') {
  const h = pubHexOf(pub);
  if (!h) return null;
  try { return bech32.encode(hrp, [0, ...bech32.toWords(ripemd160(sha256(hexToBytes(h))))]); } catch { return null; }
}

// Whether an Activity entry was made by a key other than the open one (the entries are this browser's, whichever key made them; one made with no key
// open carries none and belongs to every key).
export const madeElsewhere = (it, openPub) => { const a = pubHexOf(it?.pub), b = pubHexOf(openPub); return !!a && !!b && a !== b; };

// The other wallets Activity lists, newest entry first, one each: { pub, addr, n } with the address of the key and how many entries it made.
export function elsewhere(items, openPub) {
  const seen = new Map();
  for (const it of items || []) {
    if (!madeElsewhere(it, openPub)) continue;
    const pub = pubHexOf(it.pub), o = seen.get(pub);
    if (o) o.n++; else seen.set(pub, { pub, addr: btcAddressOf(pub), n: 1 });
  }
  return [...seen.values()];
}
