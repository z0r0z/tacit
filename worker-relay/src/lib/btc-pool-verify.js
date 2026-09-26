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

const AGG_DIR = fileURLToPath(new URL('./btc-pool-agg-verify/', import.meta.url));
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

// The aggregate verifier (T_BTC_AGG): the wasm build of sp1-verifier, pinned by SHA-256, against the guest vkey in
// pin.agg. Returns { vkey, verify({ wrap, proof, statement }) → bool } or throws.
export function loadAggregateVerifier(pin, { dir = AGG_DIR } = {}) {
  const a = pin && pin.agg;
  if (!a || !/^0x[0-9a-f]{64}$/.test(String(a.vkey || ''))) throw new Error('no aggregate key pinned');
  const wasm = new Uint8Array(readFileSync(join(dir, 'btc_pool_agg_verify_bg.wasm')));
  if (sha256(wasm) !== strip(a.verifier_wasm_sha256)) throw new Error('aggregate verifier wasm does not match its pinned SHA-256');
  const wraps = new Set(a.wraps || []);
  let mod = null;
  const load = async () => {
    if (!mod) {
      const m = await import(new URL('./btc-pool-agg-verify/btc_pool_agg_verify.js', import.meta.url).href);
      await m.default({ module_or_path: wasm });
      mod = m;
    }
    return mod;
  };
  const verify = async ({ wrap, proof, statement }) => {
    const name = wrap === 1 ? 'plonk' : wrap === 2 ? 'groth16' : null;
    if (!name || !wraps.has(name)) return false;
    const m = await load();
    try { return m.verifyAggregate(wrap, proof, statement, a.vkey) === true; } catch { return false; }
  };
  return { vkey: a.vkey, wraps: [...wraps], ready: load, verify };
}

// { enabled, reason, vkHash, system, ready(), verify({ proof, publics }) → bool,
//   verifyAggregate({ wrap, proof, statement }) → bool | undefined, aggReason } — verify is null when disabled,
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
  // Aggregates are optional: without a pinned aggregate key the indexer halts at the first aggregated carrier
  // rather than deciding it.
  let agg = null, aggReason = null;
  try { agg = loadAggregateVerifier(key.pin); } catch (e) { aggReason = `aggregate verifier unavailable: ${e.message}`; }
  return {
    enabled: true, reason: null, vkHash: system.vkHash, system, verify,
    ready: async () => { await system.ready(); if (agg) await agg.ready(); return true; },
    verifyAggregate: agg ? agg.verify : undefined, aggVkey: agg ? agg.vkey : null, aggReason,
  };
}
