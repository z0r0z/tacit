// Native verification of Bitcoin shielded-pool proofs (DESIGN-btc-shielded-pool.md §5): Groth16 over
// spend.circom against the pinned verification key, in process, through the same snarkjs bundle the dapp proves
// with (dapp/vendor/tacit-mixer.min.js). No network call and no external binary.
//
// Pin: dapp/btc-pool/pin.json names the key file and its vk_hash (btc-pool-zk-prover.js vkHash, the same bytes
// btc-pool-zk-core vk_hash hashes). BTC_POOL_VK / BTC_POOL_VK_HASH override both; a key whose hash differs from
// the pin, or a pin for another network, disables verification, and the indexer halts at the first pool
// envelope instead of diverging.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeGroth16System } from '../../../dapp/btc-pool-zk-prover.js';

export const DEFAULT_PIN_PATH = fileURLToPath(new URL('../../../dapp/btc-pool/pin.json', import.meta.url));

export function loadBtcPoolKey({ env = process.env, network = 'signet', pinPath = env.BTC_POOL_PIN || DEFAULT_PIN_PATH } = {}) {
  const pin = JSON.parse(readFileSync(pinPath, 'utf8'));
  if (pin.network !== network && !env.BTC_POOL_VK_HASH) throw new Error(`pin ${pinPath} is for ${pin.network}, not ${network}`);
  const vkFile = env.BTC_POOL_VK || join(dirname(pinPath), pin.vk);
  const vk = JSON.parse(readFileSync(vkFile, 'utf8'));
  const want = String(env.BTC_POOL_VK_HASH || pin.vk_hash || '').replace(/^0x/, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error('vk_hash pin malformed');
  return { vk, vkHash: want, vkFile };
}

// { enabled, reason, vkHash, system, verify({ proof, publics }) → bool } — verify is null when disabled, which
// acceptSpend / acceptShield treat as "cannot decide" (the indexer halts there) rather than as a rejection.
export function makeBtcPoolVerifier({ network = 'signet', env = process.env, vk = null, vkHash = null, log = console.error } = {}) {
  let system = null, reason = null;
  try {
    if (!vk) ({ vk, vkHash } = loadBtcPoolKey({ env, network }));
    system = makeGroth16System({ vk, pinnedVkHash: vkHash });
  } catch (e) { reason = `verification key unavailable: ${e.message}`; }
  if (reason) {
    log(`!!! btc-pool: proof verification DISABLED (${reason}). The first pool envelope halts the indexer.`);
    return { enabled: false, reason, vkHash: vkHash || null, system: null, verify: null };
  }
  const verify = async ({ proof, publics }) => (await system.verify(publics, proof)) === true;
  return { enabled: true, reason: null, vkHash: system.vkHash, system, verify };
}
