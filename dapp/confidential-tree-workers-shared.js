// The one set of workers a page uses to make the levels of the pool's trees (confidential-pool.js Tree.prepare) and the root of the live UTXO set (makeLiveUtxoSet().rootAsync), so the
// pool's reads (confidential-pool-ux.js) and the Bitcoin side's (tacit.js, tracked-notes.js) do not each start their own. Kept a few seconds after their last job (confidential-tree-workers.js).
import { makeTreeWorkers } from './confidential-tree-workers.js';

export const sharedTreeWorkers = makeTreeWorkers();
