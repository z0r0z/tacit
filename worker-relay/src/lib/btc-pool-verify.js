// Verification of Bitcoin shielded-pool proofs (DESIGN-btc-shielded-pool.md §5): Halo2-KZG over the spend
// relation against the pinned verification key, in process, through the same wasm the wallets prove with
// (dapp/btc-pool/btc_pool_halo2_bg.wasm). No network call and no external binary.
//
// Pin: dapp/btc-pool/pin.json names the key (vk_hash = BLAKE2b-512 of vk.bin), the params and the wasm with their
// SHA-256. BTC_POOL_VK / BTC_POOL_VK_HASH override the key and its hash; a key whose hash differs from the pin,
// a params or wasm file that differs from its pin, or a pin for another network disables verification, and the
// indexer halts at the first pool envelope instead of diverging.

import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeHalo2System } from '../../../dapp/btc-pool-halo2-prover.js';

export const DEFAULT_PIN_PATH = fileURLToPath(new URL('../../../dapp/btc-pool/pin.json', import.meta.url));

export const vkDigest = (bytes) => createHash('blake2b512').update(bytes).digest('hex');
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const strip = (h) => String(h || '').replace(/^0x/, '').toLowerCase();

export function loadBtcPoolKey({ env = process.env, network = 'signet', pinPath = env.BTC_POOL_PIN || DEFAULT_PIN_PATH } = {}) {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  if (pin.network !== network && !env.BTC_POOL_VK_HASH) throw new Error(`pin ${pinPath} is for ${pin.network}, not ${network}`);
  const dir = dirname(pinPath);
  const want = strip(env.BTC_POOL_VK_HASH || pin.vk_hash);
  if (!/^[0-9a-f]{128}$/.test(want)) throw new Error('vk_hash pin malformed');
  const vkFile = env.BTC_POOL_VK || join(dir, pin.vk);
  const vk = new Uint8Array(readFileSync(vkFile));
  const got = vkDigest(vk);
  if (got !== want) throw new Error(`verification key ${got.slice(0, 16)}… is not the pinned ${want.slice(0, 16)}…`);
  const pinned = (name, sha) => {
    const b = new Uint8Array(readFileSync(join(dir, name)));
    if (sha256(b) !== strip(sha)) throw new Error(`${name} does not match its pinned SHA-256`);
    return b;
  };
  return { vk, vkHash: want, vkFile, params: pinned(pin.params, pin.params_sha256), wasm: pinned(pin.wasm, pin.wasm_sha256), pin };
}

// { enabled, reason, vkHash, system, ready(), verify({ proof, publics }) → bool } — verify is null when disabled,
// which acceptSpend / acceptShield treat as "cannot decide" (the indexer halts there) rather than as a rejection.
// ready() loads the wasm and params once; a failure there throws from verify too, which halts the replay.
export function makeBtcPoolVerifier({ network = 'signet', env = process.env, key = null, log = console.error } = {}) {
  let system = null, reason = null, vkHash = key?.vkHash || null;
  try {
    key ||= loadBtcPoolKey({ env, network });
    vkHash = key.vkHash;
    system = makeHalo2System({ vk: key.vk, params: key.params, wasm: key.wasm, pinnedVkHash: key.vkHash, worker: null });
  } catch (e) { reason = `verification key unavailable: ${e.message}`; }
  if (reason) {
    log(`!!! btc-pool: proof verification DISABLED (${reason}). The first pool envelope halts the indexer.`);
    return { enabled: false, reason, vkHash, system: null, ready: async () => false, verify: null };
  }
  const verify = async ({ proof, publics }) => (await system.verify(publics, proof)) === true;
  return { enabled: true, reason: null, vkHash: system.vkHash, system, ready: () => system.ready().then(() => true), verify };
}
