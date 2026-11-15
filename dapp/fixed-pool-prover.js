// The withdrawal prover as the flow uses it: load a pool's commitments (the tree is built once and kept), then
// prove a note's withdrawal against it. The same two calls whether the wasm runs in a worker (the page) or
// right here (a test): `workerProver` and `directProver`.

const leavesBox = (bytes) => (bytes.buffer.byteLength === bytes.length ? bytes : bytes.slice());

// The wasm's Tree class, called in this thread.
export function directProver(Tree) {
  let tree = null;
  return {
    async load(bytes) {
      tree?.free();
      tree = new Tree(bytes);
      return { root: tree.root(), leaves: tree.leaves() };
    },
    async prove({ chainId, pool, preimageHex, recipient, relayer, fee }) {
      if (!tree) throw new Error('load the commitments first');
      return JSON.parse(relayer ? tree.prove_relayed(chainId, pool, preimageHex, recipient, relayer, String(fee)) : tree.prove(chainId, pool, preimageHex, recipient));
    },
    close() { tree?.free(); tree = null; },
  };
}

// The same, in a module worker, so the page keeps answering while the tree and the proof are made.
export function workerProver(workerUrl, { makeWorker = (u) => new Worker(u, { type: 'module' }) } = {}) {
  const w = makeWorker(workerUrl);
  const waiting = new Map();
  let next = 1;
  w.onmessage = ({ data }) => {
    const p = waiting.get(data.id);
    if (!p) return;
    waiting.delete(data.id);
    if (data.ok) p.resolve(data); else p.reject(new Error(data.error));
  };
  w.onerror = (e) => { for (const p of waiting.values()) p.reject(new Error(e.message || 'the prover stopped')); waiting.clear(); };
  const ask = (msg, transfer = []) => new Promise((resolve, reject) => { const id = next++; waiting.set(id, { resolve, reject }); w.postMessage({ id, ...msg }, transfer); });
  return {
    async load(bytes) {
      const leaves = leavesBox(bytes);
      const r = await ask({ type: 'tree', leaves }, [leaves.buffer]);
      return { root: r.root, leaves: r.leaves };
    },
    async prove(args) { return JSON.parse((await ask({ type: 'prove', ...args })).result); },
    close() { w.terminate(); },
  };
}
