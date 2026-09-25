// Runs the prover inside a worker (rayon's pool blocks, which the main thread may not).
self.onmessage = async (e) => {
  const { mode, runs, threads } = e.data;
  const say = (line, extra = {}) => self.postMessage({ line, ...extra });
  try {
    const m = await import(mode === 'threads' ? '../pkg-threads/btc_pool_halo2.js' : '../pkg/btc_pool_halo2.js');
    await m.default();
    say('module loaded');
    const n = threads || navigator.hardwareConcurrency;
    if (mode === 'threads') await m.initThreadPool(n);
    say(`mode ${mode}, rayon threads ${m.numThreads()}, hardwareConcurrency ${navigator.hardwareConcurrency}`);
    const get = async (u) => new Uint8Array(await (await fetch(u)).arrayBuffer());
    const [params, vk] = [await get('../../artifacts/params-k12.bin'), await get('../../artifacts/vk.bin')];
    let t = performance.now();
    const p = m.Prover.withVk(params, vk);
    say(`keygen_pk from vk ${((performance.now() - t) / 1000).toFixed(2)} s, vk ${p.vkDigest().slice(0, 16)}`);
    const input = m.sampleInput('pay');
    const xs = [];
    let proof;
    for (let i = 0; i < runs; i++) {
      t = performance.now();
      proof = p.prove(input);
      xs.push((performance.now() - t) / 1000);
    }
    t = performance.now();
    const ok = p.verify(proof);
    const tv = performance.now() - t;
    say(`pay: prove ${xs.map((x) => x.toFixed(2)).join(' / ')} s, verify ${ok} ${tv.toFixed(0)} ms, proof ${JSON.parse(proof).proof.length / 2} B`, { done: true, prove: xs, ok });
  } catch (err) {
    say(`error: ${err && err.stack || err}`, { done: true, error: true });
  }
};
