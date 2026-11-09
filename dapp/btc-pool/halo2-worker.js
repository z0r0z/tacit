// Module worker for btc-pool-halo2-prover.js: holds the Halo2 prover so proving never blocks the page.
//   { op: 'init', wasm, params, vk, threads? } → { vkDigest, threads }   threads: the threaded prover's wasm, over that many threads
//   { op: 'prove', input }           → { out }      out: {"proof": hex, "publics": [dec; 12]}, self-verified
//   { op: 'verify', doc }            → { valid }

// Which prover: the single one (./btc_pool_halo2.js), or the threaded one (./threads/, rayon over Web Workers) where the page is cross-origin
// isolated and the init names threads. A threaded init that fails leaves nothing behind, so the single one can be started next.
let prover = null, threads = 0;

self.onmessage = async ({ data: m }) => {
  const reply = (x) => self.postMessage({ id: m.id, ok: true, ...x });
  try {
    if (m.op === 'init') {
      if (!prover) {
        if (m.threads) {
          if (!self.crossOriginIsolated) throw new Error('the threaded prover needs a cross-origin isolated page');
          const t = await import('./threads/btc_pool_halo2.js');
          await t.default({ module_or_path: m.wasm });
          await t.initThreadPool(m.threads);
          prover = t.Prover.withVk(m.params, m.vk);
          threads = m.threads;
        } else {
          const s = await import('./btc_pool_halo2.js');
          await s.default({ module_or_path: m.wasm });
          prover = s.Prover.withVk(m.params, m.vk);
        }
      }
      reply({ vkDigest: prover.vkDigest(), threads });
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
