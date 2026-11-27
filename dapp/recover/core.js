import { secp, sha256, ripemd160, bech32, bytesToHex, hexToBytes } from '/vendor/tacit-deps.min.js';
import { prfBytesToScalar } from '/prf-wallet.js';
import { identityMessage } from '/identity-message.js';

export const PBKDF2_ITER = 600000;
export const STORAGE_FORMAT_VERSION = 1;
export const HISTORICAL_MESSAGES = Object.freeze([
  { id: 'current', label: 'current', text: (net) => identityMessage({ netName: net }) },
  { id: 'signin', label: 'September 2026 sign-in text', text: (net) => `tacit.finance: derive your Tacit identity on ${net}.\n\nSign this only on https://tacit.finance. It sends no transaction and moves no funds.` },
  { id: 'original', label: 'original text', text: (net) => `Sign this message to derive your tacit.finance identity.\n\nnetwork: ${net}\nversion: 1\n\nThis signature will not send any transaction or spend any funds.` },
]);

const SLOT = /^tacit-wallet-v1:(mainnet|signet)(?::by:(.+))?$/;
const IDENTITY = /^(tacit-(?:btc|eth)-identity|tacit-btc-wallet-v1)(?::(mainnet|signet))?$/;
const validPub = (s) => typeof s === 'string' && /^0[23][0-9a-f]{64}$/i.test(s);

export function addressFromPub(pub, net = 'mainnet') {
  const p = pub instanceof Uint8Array ? pub : hexToBytes(pub);
  const h = ripemd160(sha256(p));
  return bech32.encode(net === 'mainnet' ? 'bc' : 'tb', [0, ...bech32.toWords(h)]);
}

export function inspectStorage(storage) {
  const slots = [], identities = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i), raw = storage.getItem(key);
    const sm = SLOT.exec(key);
    if (sm) {
      const slot = { key, network: sm[1], binding: sm[2] || null, shape: 'malformed', pubkey: null, address: null };
      if (/^[0-9a-f]{64}$/i.test(raw || '')) {
        slot.shape = 'plaintext';
        try { slot.pubkey = bytesToHex(secp.getPublicKey(hexToBytes(raw), true)); } catch { slot.shape = 'malformed'; }
      } else {
        try { const b = JSON.parse(raw); if (b.v === STORAGE_FORMAT_VERSION && validPub(b.pub)) { slot.shape = 'encrypted'; slot.pubkey = b.pub.toLowerCase(); } } catch {}
      }
      if (slot.pubkey) slot.address = addressFromPub(slot.pubkey, slot.network);
      slots.push(slot);
      continue;
    }
    const im = IDENTITY.exec(key);
    if (im) {
      let record = null; try { record = JSON.parse(raw); } catch {}
      identities.push({ key, kind: im[1].includes('eth') ? 'Ethereum wallet' : 'Bitcoin wallet signature', network: im[2] || record?.network || 'unknown', record });
    } else if (key === 'tacit-prf-v1') {
      identities.push({ key, kind: 'passkey', network: 'all', record: null });
    }
  }
  return { slots, identities };
}

async function deriveKdf(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, base, 256));
}

export async function encryptPrivkey(priv, passphrase) {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await crypto.subtle.importKey('raw', await deriveKdf(passphrase, salt, PBKDF2_ITER), 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, priv));
  return JSON.stringify({ v: 1, kdf: 'pbkdf2', iter: PBKDF2_ITER, salt: bytesToHex(salt), iv: bytesToHex(iv), ct: bytesToHex(ct), pub: bytesToHex(secp.getPublicKey(priv, true)) });
}

export async function decryptPrivkey(raw, passphrase) {
  let b; try { b = JSON.parse(raw); } catch { throw new Error('Saved wallet data is malformed.'); }
  if (b.v !== 1 || b.kdf !== 'pbkdf2') throw new Error('This saved wallet format is not supported.');
  const iter = Number.isInteger(b.iter) && b.iter >= 100000 ? Math.min(b.iter, 5000000) : PBKDF2_ITER;
  try {
    const key = await crypto.subtle.importKey('raw', await deriveKdf(passphrase, hexToBytes(b.salt), iter), 'AES-GCM', false, ['decrypt']);
    const out = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: hexToBytes(b.iv) }, key, hexToBytes(b.ct)));
    if (out.length !== 32) throw new Error();
    return out;
  } catch { throw new Error('Wrong passphrase or damaged saved wallet data.'); }
}

export function keyFromSignature(signature) {
  const sig = signature instanceof Uint8Array ? signature : Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
  return prfBytesToScalar(sha256(sig));
}

export function signatureResult(signature, network) {
  const priv = keyFromSignature(signature), pubkey = bytesToHex(secp.getPublicKey(priv, true));
  return { priv, pubkey, address: addressFromPub(pubkey, network) };
}

export async function addressActivity(address, network = 'mainnet', fetcher = fetch) {
  const base = network === 'mainnet' ? 'https://mempool.space/api' : 'https://mempool.space/signet/api';
  const r = await fetcher(`${base}/address/${address}`);
  if (!r.ok) throw new Error(`Explorer returned ${r.status}.`);
  const j = await r.json(), c = j.chain_stats || {}, m = j.mempool_stats || {};
  return { sats: Number(c.funded_txo_sum || 0) - Number(c.spent_txo_sum || 0) + Number(m.funded_txo_sum || 0) - Number(m.spent_txo_sum || 0), txs: Number(c.tx_count || 0) + Number(m.tx_count || 0) };
}
