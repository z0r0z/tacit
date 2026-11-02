// Spend-guard classifier: for a list of Bitcoin outpoints, say which of them are Tacit asset notes.
//
// Built for wallets that hold coins under a script with no single key (a multisig vault), where the
// owner-keyed /holdings lookup cannot work. Nothing here needs a key or a published opening: whether a coin
// is a Tacit note, and of which asset, is a function of chain data alone (the creating transaction's
// envelope, walked back to the etch by verifyTacAncestry).
//
// Every coin gets one of three answers, and a spend guard must treat them differently:
//   asset       a verified Tacit note of asset_ids[0]. Never spend it as sats.
//   plain       provably not a Tacit note: its creating transaction carries no Tacit envelope on any input,
//               or the envelope's own rules put this vout outside the notes it creates. Safe to spend as sats.
//   unverified  could be a note and could not be shown not to be (a lookup failed, the op is one the walk
//               does not cover, a pool exit rode a later input, the request ran out of budget). Treat as an
//               asset until a later call says otherwise: this is the fail-closed arm.
// "Not in the answer" is never a safe verdict; the caller reads `status`.
//
// Deps are injected, same convention as tac-ancestry.js.
const OUTPOINT_RE = /^[0-9a-f]{64}:\d{1,9}$/;
export const CLASSIFY_MAX_OUTPOINTS = 100;
// Ancestry walks (the costly part) per request. Verdicts are cached forever once proven, so a caller that
// retries `unverified` coins converges even when a request hits this.
const WALK_BUDGET = 25;
// A cold walk fetches every ancestor over public explorers and can take many seconds. Past this, the rest
// answer `unverified` so the request returns; each hop a walk proved is cached, so a retry picks up there.
const DEADLINE_MS = 20_000;
const CONCURRENCY = 6;

// A proven asset note is a fact about immutable history, so its verdict is kept in KV and answered without the
// explorer: when every explorer is down, notes already proven still answer `asset` rather than `unverified`.
// Only `asset` is kept. It is the answer that blocks a sats spend, so a stale entry can only over-block; `plain`
// is always read off the chain. Written once the creating transaction is confirmed. Bump the version to drop the
// entries if the classification rules change. Best-effort like the ancestry cache: no KV, or a KV error, is a miss.
const assetKey = (network, txid, vout) => `tacclass:v1:${network}:${txid}:${vout}`;
async function loadAsset(env, network, txid, vout) {
  if (!env?.REGISTRY_KV) return null;
  try {
    const v = await env.REGISTRY_KV.get(assetKey(network, txid, vout), 'json');
    const ids = v?.asset_ids;
    return Array.isArray(ids) && ids.length === 1 && /^[0-9a-f]{64}$/.test(ids[0]) ? ids : null;
  } catch { return null; }
}
async function saveAsset(env, network, txid, vout, assetIds) {
  if (!env?.REGISTRY_KV) return;
  try { await env.REGISTRY_KV.put(assetKey(network, txid, vout), JSON.stringify({ asset_ids: assetIds })); }
  catch { /* the next call re-verifies */ }
}

export function makeOutpointClassifier({ apiJson, decodeEnvelopeScript, hexToBytes, verifyTacAncestry }) {
  // A taproot script-path witness ends [..., script, control_block] with an optional annex after, so scan
  // every element rather than guess the position. decodeEnvelopeScript returns null for anything else.
  function envelopeOf(input) {
    const w = input?.witness;
    if (!Array.isArray(w) || w.length < 3) return null;
    for (const item of w) {
      if (typeof item !== 'string' || item.length < 72 || !/^[0-9a-f]+$/i.test(item)) continue;
      let env = null;
      try { env = decodeEnvelopeScript(hexToBytes(item)); } catch { env = null; }
      if (env) return env;
    }
    return null;
  }

  async function mapLimit(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); }
    }));
    return out;
  }

  // outpoints: validated "txid:vout" strings (lowercase). Returns { "<txid>:<vout>": { status, ... } }.
  async function classifyOutpoints(env, network, outpoints) {
    const coins = {};
    const byTx = new Map();
    for (const op of outpoints) {
      const [txid, v] = op.split(':');
      if (!byTx.has(txid)) byTx.set(txid, []);
      byTx.get(txid).push(Number(v));
    }
    const memo = new Map();
    const t0 = Date.now();
    let walks = 0;
    await mapLimit([...byTx.keys()], CONCURRENCY, async (txid) => {
      const mark = (vout, verdict) => { coins[`${txid}:${vout}`] = verdict; };
      const kept = await Promise.all(byTx.get(txid).map((v) => loadAsset(env, network, txid, v)));
      const vouts = byTx.get(txid).filter((v, i) => {
        if (kept[i]) mark(v, { status: 'asset', asset_ids: kept[i] });
        return !kept[i];
      });
      if (!vouts.length) return;
      let tx;
      try { tx = await apiJson(env, `/tx/${txid}`, {}, network); }
      catch (e) { for (const v of vouts) mark(v, { status: 'unverified', reason: 'transaction lookup failed' }); return; }
      if (!tx || !Array.isArray(tx.vin) || !Array.isArray(tx.vout)) {
        for (const v of vouts) mark(v, { status: 'unverified', reason: 'transaction lookup failed' });
        return;
      }
      // Pool exits ride any input, so look at all of them, not only vin[0].
      const envelopes = tx.vin.map(envelopeOf);
      if (!envelopes.some(Boolean)) { for (const v of vouts) mark(v, { status: 'plain' }); return; }
      if (!envelopes[0] || envelopes.slice(1).some(Boolean)) {
        for (const v of vouts) mark(v, { status: 'unverified', reason: 'Tacit envelope on an input the walk does not cover' });
        return;
      }
      for (const v of vouts) {
        if (v >= tx.vout.length) { mark(v, { status: 'unverified', reason: 'no such output' }); continue; }
        if (walks >= WALK_BUDGET || Date.now() - t0 > DEADLINE_MS) { mark(v, { status: 'unverified', reason: 'request over budget, retry' }); continue; }
        walks++;
        let r;
        try { r = await verifyTacAncestry(env, txid, v, network, { memo }); }
        catch (e) { r = { ok: false, reason: 'ancestry walk failed' }; }
        if (r.ok) {
          mark(v, { status: 'asset', asset_ids: [r.assetIdHex] });
          if (tx.status?.confirmed === true) await saveAsset(env, network, txid, v, [r.assetIdHex]);
        } else if (r.notTacit) mark(v, { status: 'plain' });
        else mark(v, { status: 'unverified', reason: String(r.reason || 'not verified').slice(0, 160) });
      }
    });
    return coins;
  }

  // The route body: validation, then the answer in the shape a client reads. `assets` and `unverified` are
  // derived from `coins` so a client can read whichever it prefers.
  async function handleClassify(req, env, network, respond) {
    let body;
    try { body = await req.json(); } catch { return respond({ error: 'invalid JSON body' }, 400); }
    const list = body?.outpoints;
    if (!Array.isArray(list) || list.length === 0) return respond({ error: 'outpoints must be a non-empty array of "<txid>:<vout>"' }, 400);
    if (list.length > CLASSIFY_MAX_OUTPOINTS) return respond({ error: `outpoints capped at ${CLASSIFY_MAX_OUTPOINTS}` }, 400);
    const ops = [];
    for (const o of list) {
      const s = typeof o === 'string' ? o.toLowerCase() : '';
      if (!OUTPOINT_RE.test(s)) return respond({ error: 'each outpoint must be "<txid hex>:<vout>"' }, 400);
      if (!ops.includes(s)) ops.push(s);
    }
    const coins = await classifyOutpoints(env, network, ops);
    const assets = {};
    const unverified = [];
    for (const op of ops) {
      const c = coins[op] || { status: 'unverified', reason: 'not classified' };
      coins[op] = c;
      if (c.status === 'asset') assets[op] = c.asset_ids;
      else if (c.status === 'unverified') unverified.push(op);
    }
    return respond({ network, coins, assets, unverified }, 200);
  }

  return { classifyOutpoints, handleClassify };
}
