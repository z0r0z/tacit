// Transparent-note validation for T_BTC_SHIELD inputs (DESIGN-btc-shielded-pool.md §5 step 2). Runs the
// dapp's own validateOutpoint, the rule every Tacit wallet applies, so the pool accepts exactly the notes
// wallets credit.
//
// Outcomes are three-way. A note that fails validation resolves to null and the shield is rejected. Anything
// that leaves the answer unknown (a Bitcoin source or a Tacit service unreachable or erroring) throws, so the
// block is retried rather than decided on partial data. A tx every Bitcoin source reports as unknown (404) is
// a definitive answer, since an ancestry can name txids that never existed.

import { parseTx } from './btc-pool-chain.js';
import { bytesToHex, pointFromCompressed, pointXY } from '../../../worker/src/btc-shielded-pool.js';

export class TransparentUnavailableError extends Error {
  constructor(msg) { super(msg); this.name = 'TransparentUnavailableError'; }
}

// Outputs of T_BTC_SPEND exits resolve against the replay's own exit set through this origin, so the dapp's
// pool-exit consult never leaves the process and answers from the state being replayed.
const POOL_ORIGIN = 'http://btc-pool.replay';
// The dapp's T_CROSSOUT_MINT status read. An answer the service does not mark decided leaves the verdict unknown.
const CROSSOUT_STATUS_PATH = '/crossout/minted?';

let loaded = null; // { network, tacit, realFetch }
let active = null; // { failures, exits } while one resolution runs

// tacit.js is a browser module: it needs a DOM and reads its network from localStorage at import time, so it
// is loaded once per process for one network.
export async function loadTacit(network) {
  if (loaded) {
    if (loaded.network !== network) throw new Error(`tacit.js already loaded for ${loaded.network}`);
    return loaded.tacit;
  }
  const { JSDOM } = await import('jsdom');
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/', pretendToBeVisual: true });
  const g = globalThis;
  const set = (k, v) => { try { g[k] = v; } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }); } };
  set('window', dom.window);
  set('document', dom.window.document);
  set('localStorage', dom.window.localStorage);
  set('location', dom.window.location);
  if (!g.navigator) set('navigator', dom.window.navigator);
  g.__TACIT_NO_INIT__ = true;
  g.__TACIT_BTC_POOL_API__ = POOL_ORIGIN;
  dom.window.localStorage.setItem('tacit-network-v1', network);

  const realFetch = g.fetch;
  g.fetch = async (input, init) => {
    const url = String(input?.url ?? input);
    if (url.startsWith(POOL_ORIGIN + '/')) return poolExitResponse(url, active);
    // Reads that fail or error leave the verdict unknown. Writes (fire-and-forget hints) never decide it.
    const ctx = String(init?.method || 'GET').toUpperCase() === 'GET' ? active : null;
    try {
      const r = await realFetch(input, init);
      if (ctx && (r.status >= 500 || r.status === 429)) ctx.failures.push(`${url} -> ${r.status}`);
      else if (ctx && url.includes(CROSSOUT_STATUS_PATH)) {
        const j = r.ok ? await r.clone().json().catch(() => null) : null;
        if (!j || j.decided !== true) ctx.failures.push(`${url} -> undecided`);
      }
      return r;
    } catch (e) {
      if (ctx) ctx.failures.push(`${url}: ${e?.message || e}`);
      throw e;
    }
  };
  const tacit = await import('../../../dapp/tacit.js');
  loaded = { network, tacit, realFetch };
  return tacit;
}

function poolExitResponse(url, ctx) {
  const m = url.slice(POOL_ORIGIN.length).match(/^\/btc-pool\/exit\/([0-9a-f]{64})\/(\d+)$/);
  const x = m && ctx && ctx.exits.get(`${m[1]}:${Number(m[2])}`);
  const body = x
    ? { exists: true, txid: x.txid, vout: x.vout, asset: bytesToHex(x.asset), Cx: bytesToHex(x.cx), Cy: bytesToHex(x.cy) }
    : { exists: false };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const toHex = (b) => bytesToHex(b);
// The validator swallows some fetch errors, so the failure is also recorded against the running resolution.
function unavailable(msg) {
  if (active) active.failures.push(msg);
  throw new TransparentUnavailableError(msg);
}

// validateOutpoint's fetchTx: esplora-shaped { txid, vin, vout, status } built from the raw tx (checked
// against its txid) plus its confirmation status. null for a tx no source knows; throws otherwise.
function makeFetchTx(esplora, cacheSize) {
  const cache = new Map();
  return async (txid) => {
    const hit = cache.get(txid);
    if (hit) return hit;
    let raw, status;
    try {
      [raw, status] = await Promise.all([esplora.rawTx(txid), esplora.txStatus(txid)]);
    } catch (e) {
      if (e && e.notFound) return null;
      return unavailable(`tx ${txid}: ${e?.message || e}`);
    }
    let tx;
    try { tx = parseTx(raw).tx; } catch (e) { return unavailable(`tx ${txid}: ${e.message}`); }
    if (tx.txid !== txid) return unavailable(`tx ${txid} fetched with txid ${tx.txid}`);
    const out = {
      txid,
      vin: tx.vin.map((i) => ({ txid: i.txid, vout: i.vout, witness: i.witness.map(toHex) })),
      vout: tx.vout.map((o) => ({ scriptpubkey: toHex(o.scriptPubKey), value: Number(o.value) })),
      status: status && typeof status === 'object' ? status : { confirmed: false },
    };
    if (out.status.confirmed) {
      cache.set(txid, out);
      if (cache.size > cacheSize) cache.delete(cache.keys().next().value);
    }
    return out;
  };
}

// resolveShieldInput(txid, vout) → { asset: hex, Cx, Cy } for a valid transparent note, null when it is not
// one; throws TransparentUnavailableError when the answer cannot be determined now.
// `exits()` returns the replay's live exit map ("txid:vout" → { txid, vout, asset, cx, cy }).
export function makeShieldInputResolver({ esplora, network, exits, cacheSize = 5000 }) {
  const fetchTx = makeFetchTx(esplora, cacheSize);
  return async function resolveShieldInput(txid, vout) {
    const own = exits().get(`${txid}:${vout}`);
    if (own) return { asset: bytesToHex(own.asset), Cx: own.cx, Cy: own.cy };

    const tacit = await loadTacit(network);
    if (active) throw new Error('shield input resolution is not reentrant');
    const ctx = active = { failures: [], exits: exits() };
    try {
      tacit.clearBtcPoolExitCache();
      let note = null, err = null;
      try {
        if ((await tacit.validateOutpoint(txid, vout, new Map(), fetchTx, 0, null, null, null, new Map())) === true) {
          // The commitment the validator itself binds when this outpoint is spent (getParentEnvelopeData).
          const env = tacit.txOutputEnvelope(await fetchTx(txid));
          const pd = env ? await tacit.getParentEnvelopeData(env, vout, txid) : null;
          const C = pd && pd.commitment instanceof Uint8Array ? pointFromCompressed(pd.commitment) : null;
          if (C) note = { asset: String(pd.assetIdHex).toLowerCase(), ...pointXY(C) };
        }
      } catch (e) { err = e; }
      if (ctx.failures.length) throw new TransparentUnavailableError(`validating ${txid}:${vout}: ${ctx.failures[0]}`);
      // Any other exception comes from the validator's own code on this ancestry, deterministically: not a note.
      if (err) return null;
      return note ? { asset: note.asset, Cx: note.cx, Cy: note.cy } : null;
    } finally {
      active = null;
    }
  };
}
