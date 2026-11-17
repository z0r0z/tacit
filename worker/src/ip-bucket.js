// A client's address as a rate-limit key. The limiters need to tell one source from another, not to know who it is, so the key
// is a keyed hash: it cannot be turned back into an address (a bare hash of an IPv4 address can, by trying them all), and nothing
// that reads the store learns who asked. The key is IP_HASH_SALT when set; otherwise a salt made when this process starts, which
// also means a restart forgets who was limited, a fair price. Sentinels that are not addresses pass through.
import { sha256 } from '@noble/hashes/sha256';
import { hmac } from '@noble/hashes/hmac';
import { bytesToHex } from '@noble/hashes/utils';

const processSalt = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
export const ipBucket = (env, ip) => (!ip || ip === 'anon' || ip === '*' || ip === 'all' ? ip
  : bytesToHex(hmac(sha256, new TextEncoder().encode(String(env.IP_HASH_SALT || processSalt)), new TextEncoder().encode(String(ip)))).slice(0, 24));
