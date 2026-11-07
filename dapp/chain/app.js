import { tacitChain } from '/tacit-chain-config.js?cb=803c3298';
import { mountChain } from '/chain/ui.js?cb=94364e10';

// The tacit chain's page: the chain read from Ethereum (the landing contract) and its leader, with links into the tile's moves. A key is opened
// once, in the front page's wallet (its balance there, its address with the chain lane, published as it opens); this page asks for none, so
// moving between the two never asks for a second signature. While the chain is not deployed the page says so and loads nothing of it.
const cfg = tacitChain();
const $ = (id) => document.getElementById(id);
const S = { on: !!cfg, status: null, key: null, note: '' };
// the wallet is the front page's: one sign-in, there
const signIn = () => { location.href = '/#wallet'; };
const ui = mountChain({ root: $('chain'), actions: { signIn } });
const draw = () => ui.render({ ...S, now: Date.now() });
draw();

let rpc = null, client = null;
const rpcCall = (m, p) => rpc(m, p);

async function readStatus() {
  try { S.status = await client.chainStatus({ cfg, rpcCall }); } catch { if (!S.status || S.status === 'error') S.status = 'error'; }
  draw();
}

if (cfg) {
  const chip = $('wallet-chip');
  if (chip) { chip.hidden = false; $('wallet-label').textContent = 'Wallet'; chip.setAttribute('aria-label', 'Your wallet'); chip.onclick = signIn; }
  // what the page needs only while the chain is on: the chain's client and the reads of Ethereum
  const [u, cm] = await Promise.all([import('/trade/util.js?cb=ba5a02b1'), import('/tacit-chain-client.js?cb=17e554e6')]);
  rpc = u.rpc; client = cm;
  readStatus();
  setInterval(() => { if (!document.hidden) readStatus(); }, 30e3);
  setInterval(() => { if (!document.hidden) draw(); }, 15e3);
}
