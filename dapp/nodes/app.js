import { mountNodes } from '/nodes/ui.js?cb=da52be15';
import { NODES_API, PROBER_PUBS, checkDoc } from '/nodes-list.js?cb=16e824fe';
import { nodesOnly } from '/community-nodes.js';

// The status is the prober's, signed with a key this build pins; the page shows it only if it verifies.
const load = async () => {
  const r = await fetch(`${NODES_API}/status`, { credentials: 'omit', signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('status');
  return r.json();
};
const ui = mountNodes({ root: document.querySelector('main'), load, pubs: PROBER_PUBS, check: (s) => checkDoc('status', s, PROBER_PUBS), nodesOnly });
ui.refresh();
setInterval(() => { if (!document.hidden) ui.refresh(); }, 120_000);
