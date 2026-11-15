// Runs the withdrawal prover off the page's thread. See ../fixed-pool-prover.js for the other end.
import init, { Tree } from '../vendor/fixed-pool-prover.js';

let tree = null;
const ready = init();
const reply = (id, body) => self.postMessage({ id, ok: true, ...body });
const fail = (id, e) => self.postMessage({ id, ok: false, error: String(e?.message || e) });

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    await ready;
    if (type === 'tree') {
      tree?.free();
      tree = new Tree(data.leaves);
      reply(id, { root: tree.root(), leaves: tree.leaves() });
    } else if (type === 'prove') {
      if (!tree) throw new Error('load the commitments first');
      reply(id, { result: tree.prove(data.chainId, data.pool, data.preimageHex, data.recipient) });
    } else throw new Error(`unknown request ${type}`);
  } catch (e) { fail(id, e); }
};
