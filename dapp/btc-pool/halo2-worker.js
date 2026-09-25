// Module worker for btc-pool-halo2-prover.js: holds the Halo2 prover so proving never blocks the page.
//   { op: 'init', wasm, params, vk } → { vkDigest }
//   { op: 'prove', input }           → { out }      out: {"proof": hex, "publics": [dec; 12]}, self-verified
//   { op: 'verify', doc }            → { valid }

import init, { Prover } from './btc_pool_halo2.js';

let prover = null;

self.onmessage = async ({ data: m }) => {
  const reply = (x) => self.postMessage({ id: m.id, ok: true, ...x });
  try {
    if (m.op === 'init') {
      if (!prover) {
        await init({ module_or_path: m.wasm });
        prover = Prover.withVk(m.params, m.vk);
      }
      reply({ vkDigest: prover.vkDigest() });
    } else if (!prover) {
      throw new Error('prover not initialised');
    } else if (m.op === 'prove') {
      const out = prover.prove(m.input);
      if (!prover.verify(out)) throw new Error('fresh proof does not verify');
      reply({ out });
    } else if (m.op === 'verify') {
      reply({ valid: prover.verify(m.doc) === true });
    } else {
      throw new Error(`unknown op ${m.op}`);
    }
  } catch (e) {
    self.postMessage({ id: m.id, ok: false, error: String(e?.message || e) });
  }
};
