// tacit.finance/etch, Discover: the assets etched on Bitcoin, from the registry the API keeps, searched in the page. The registry is read once (about 70 KB for
// every asset), a name and a logo come from each asset's metadata on IPFS through the API's batch read, and nothing here needs tacit.js or a key.
import { API } from '/trade/util.js?cb=ba5a02b1';

const NET = 'mainnet';
const CID = /^(?:Qm[1-9A-HJ-NP-Za-km-z]{44}|baf[a-z0-9]{50,80})$/i;
const cidOf = (uri) => { const s = String(uri || '').trim(), m = /^ipfs:\/\/([A-Za-z0-9]+)/.exec(s); const c = m ? m[1] : s; return CID.test(c) ? c : null; };
export const ipfs = (cid) => `${API}/ipfs/${cid}`;

// Every asset as the page shows it. An asset is `later` when another one with its ticker was etched before it: tickers are not unique, so a row says so.
export function normalize(list) {
  const out = [];
  for (const a of Array.isArray(list) ? list : []) {
    const id = String(a?.asset_id || '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(id) || !a.ticker) continue;
    let supply = null;
    try { if (/^\d+$/.test(String(a.attestation?.supply ?? ''))) supply = BigInt(a.attestation.supply); } catch { /* an unreadable supply is left unshown */ }
    out.push({
      id, ticker: String(a.ticker), decimals: Number.isInteger(a.decimals) ? a.decimals : 0, etchTxid: /^[0-9a-f]{64}$/i.test(a.etch_txid || '') ? a.etch_txid.toLowerCase() : null,
      at: Number(a.etched_at) || 0, height: Number.isInteger(a.etched_at_height) ? a.etched_at_height : Infinity, mintable: a.mintable === true, verified: a.verified === true,
      supply, holders: Number(a.holder_count) || 0, cid: cidOf(a.image_uri), name: '', logo: null, later: false, same: 0,
    });
  }
  // by when it was etched: the registry gives some assets no height, and a missing one must not read as the newest; the height orders those of one moment
  const order = (x, y) => (x.at || Infinity) - (y.at || Infinity) || x.height - y.height || (x.id < y.id ? -1 : 1);
  const groups = new Map();
  for (const a of out) { const k = a.ticker.toLowerCase(); (groups.get(k) || groups.set(k, []).get(k)).push(a); }
  for (const g of groups.values()) { g.sort(order); g.forEach((a, i) => { a.same = g.length - 1; a.later = i > 0; }); }
  return out.sort((x, y) => order(y, x));
}

export async function loadAssets(fetcher = fetch) {
  const r = await fetcher(`${API}/assets?network=${NET}&mints=0`, { signal: AbortSignal.timeout(20e3) });
  if (!r.ok) throw new Error(`the registry answered ${r.status}`);
  return normalize((await r.json())?.assets);
}

// A name and a logo for each asset: the image an asset names is a metadata JSON (a name, a description and the logo inside it) or the logo itself. The batch
// read returns the JSON ones parsed and an error for the rest, which are logos. `onRead` is told after each batch of 32.
export async function readNames(assets, onRead = () => {}, fetcher = fetch) {
  const byCid = new Map();
  for (const a of assets) if (a.cid) (byCid.get(a.cid) || byCid.set(a.cid, []).get(a.cid)).push(a);
  const cids = [...byCid.keys()];
  const batches = [];
  for (let i = 0; i < cids.length; i += 32) batches.push(cids.slice(i, i + 32));
  await Promise.all(batches.map(async (chunk) => {
    let blobs = {};
    try {
      const r = await fetcher(`${API}/ipfs/batch`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cids: chunk }), signal: AbortSignal.timeout(20e3) });
      blobs = r.ok ? (await r.json())?.blobs || {} : {};
    } catch { /* the rows stay with a ticker and a letter */ }
    for (const cid of chunk) {
      const j = blobs[cid], isJson = j && typeof j === 'object' && !j.error;
      const name = isJson && typeof j.name === 'string' ? j.name.replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 64) : '';
      const inner = isJson ? cidOf(j.image) : null;
      for (const a of byCid.get(cid)) {
        a.name = name && name.toLowerCase() !== a.ticker.toLowerCase() ? name : '';
        a.logo = isJson ? (inner ? ipfs(inner) : null) : ipfs(cid);
      }
    }
    onRead();
  }));
}

// What a search matches: a ticker or a name that holds it, or an asset id that begins with it (four hex digits or more). An id is compared without its 0x,
// so a Bitcoin asset's bare id and a token's 0x address are found either way.
const bare = (s) => s.replace(/^0x/, '');
const ID_TERM = /^(0x)?[0-9a-f]{4,64}$/;
export function matches(a, q) {
  const t = String(q || '').trim().toLowerCase();
  if (!t) return true;
  return a.ticker.toLowerCase().includes(t) || a.name.toLowerCase().includes(t) || (ID_TERM.test(t) && bare(a.id).startsWith(bare(t)));
}
// The ticker typed exactly (or an asset id), then tickers that begin with it, then the rest. Among exact ones the listed asset comes first, then the earliest of
// its ticker; everything else keeps the order it came in (newest first).
export function search(assets, q) {
  const t = String(q || '').trim().toLowerCase();
  if (!t) return assets;
  const key = (a, i) => { const exact = a.ticker.toLowerCase() === t || (ID_TERM.test(t) && bare(a.id).startsWith(bare(t))); return [exact ? 0 : a.ticker.toLowerCase().startsWith(t) ? 1 : 2, exact && !a.verified ? 1 : 0, exact && a.later ? 1 : 0, i]; };
  const cmp = (x, y) => { for (let n = 0; n < 4; n++) if (x[n] !== y[n]) return x[n] - y[n]; return 0; };
  return assets.filter((a) => matches(a, t)).map((a, i) => [a, key(a, i)]).sort((x, y) => cmp(x[1], y[1])).map(([a]) => a);
}
