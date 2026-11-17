// A node on the reader's own computer: a light client or a full node at 127.0.0.1:8545. When the reader turns it on (Wallet sheet), the page puts it first in the one list of
// Ethereum nodes (eth-nodes.js ETH_NODES, changed in place, so every module that reads that list asks it first and a public node only when it does not answer in time).
//
// It sits in the list only while it is up and within a few blocks of the public nodes. A node that is down would be tried before every read, and one that lags would hand the page an old pool
// root and head, which a proof built on would not survive; a check every half minute puts it in when it is in step and takes it out when it is not. The setting stays on either way.
//
// Nothing here makes a request until the reader has turned it on, and the address is never taken from a link or a field: a page that reached for 127.0.0.1 unasked would raise the browser's
// local-network prompt for every visitor, and a link that named a node could hand a visitor a lying one.
import { ETH_NODES } from './eth-nodes.js';
import { hedgedRpc } from './trade/rpc.js';

export const OWN_NODE = 'http://127.0.0.1:8545';
const KEY = 'tacit-own-node-v1', STEP = 6, EVERY = 30e3;
const NODE = OWN_NODE.replace(/^http:\/\//, '');

const stored = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
const keep = (on) => { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { } };

let on = false, timer = 0, last = null;
export const ownNodeOn = () => on;
export const ownNodeUsed = () => ETH_NODES.includes(OWN_NODE);
export const ownNodeLast = () => last;

// One call to the node. application/json, as every node expects from a browser: a node with CORS on answers the preflight it brings.
async function callOwn(method, params, { fetchImpl = (...a) => fetch(...a), timeoutMs = 8000 } = {}) {
  const ctl = new AbortController(), t = setTimeout(() => ctl.abort(), timeoutMs);
  let r, j;
  try {
    r = await fetchImpl(OWN_NODE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: ctl.signal });
    j = await r.json().catch(() => null);
  } catch (e) { throw Object.assign(new Error(e?.message || 'no reply'), { unreachable: true }); } finally { clearTimeout(t); }
  if (j && 'result' in j) return j.result;
  throw new Error(j?.error?.message || `it answered ${r.status} and not in JSON-RPC`);
}

// The head the public nodes agree the chain is at (the own node is left out of the question).
const publicHead = async () => Number(BigInt(await hedgedRpc(ETH_NODES.filter((u) => u !== OWN_NODE), 'eth_blockNumber', [], { hedgeMs: 1500, timeoutMs: 8000 })));

// Is it there, on Ethereum, and in step? `ok` says all three; `block` and `behind` say what was found.
export async function checkOwnNode({ call = callOwn, head = publicHead } = {}) {
  let chain, block;
  try {
    chain = BigInt(await call('eth_chainId', []));
    block = Number(BigInt(await call('eth_blockNumber', [])));
  } catch (e) { return { ok: false, up: false, unreachable: !!e.unreachable, error: e.message }; }
  if (chain !== 1n) return { ok: false, up: true, chain: Number(chain), block };
  let behind = null;
  try { behind = Math.max(0, (await head()) - block); } catch { }
  return { ok: behind == null || behind <= STEP, up: true, chain: 1, block, behind };
}

// What the Wallet sheet says of a check.
export function ownNodeSay(r) {
  if (!r.up) return r.unreachable ? `Nothing answered at ${NODE}. Is the node running? The browser has to be allowed to reach it, and the node has to allow this page’s origin (CORS).` : `The node at ${NODE} said: ${r.error}.`;
  if (r.chain !== 1) return `The node at ${NODE} is on chain ${r.chain}, not Ethereum.`;
  const at = `block ${r.block.toLocaleString('en-US')}`;
  if (!r.ok) return `It is ${r.behind} blocks behind Ethereum (at ${at}), too far to read from. It is used again once it is within ${STEP}.`;
  return `Answering at ${at}${r.behind ? `, ${r.behind} behind the public nodes` : ''}.`;
}

const place = (want) => {
  const i = ETH_NODES.indexOf(OWN_NODE);
  if (want && i < 0) ETH_NODES.unshift(OWN_NODE); else if (!want && i >= 0) ETH_NODES.splice(i, 1);
};
async function watch() {
  if (!on || (typeof document !== 'undefined' && document.hidden)) return;
  const r = await checkOwnNode();
  if (on) { last = r; place(r.ok); }
}
function start(look = true) {
  on = true; place(true);
  if (look) watch();
  if (!timer) timer = setInterval(watch, EVERY);
}

// Turn it on if it is there. A node that is down, on another chain or far behind is not turned on, and the check says why.
export async function enableOwnNode(opts) {
  const r = await checkOwnNode(opts);
  if (r.ok) { keep(true); last = r; start(false); }
  return r;
}
export function disableOwnNode() {
  on = false; last = null; keep(false);
  clearInterval(timer); timer = 0;
  place(false);
}

if (stored()) start();
