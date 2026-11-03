// What a process holding a key reads about its own Bitcoin TAC without a page: its notes, opened from the chain with
// tacit.js's own opener, and whether the bridge's proof follows a note, from the reflection's live set. The swap desk's
// inventory and tracking (dapp/btcswap-desk.js).

const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const rev = (h) => strip(h).match(/../g).reverse().join('');
const hexToBytes = (h) => Uint8Array.from(strip(h).match(/../g) || [], (x) => parseInt(x, 16));

// The key's unspent, confirmed notes of `asset` at its P2WPKH address. `btc` is the fast bridge's Bitcoin seam
// (dapp/fastbridge-btc.js, with `tacit` given so it resolves notes); an opened note is kept, and a spent one dropped.
export function makeOwnNotes({ btc, tacit, asset, pages = 8, ttlMs = 60000, now = () => Date.now() }) {
  const own = Array.from(btc.prims.p2wpkhScript(btc.wallet.pub), (b) => b.toString(16).padStart(2, '0')).join('');
  const opened = new Map();
  let cache = null;
  const decode = (payload) => { for (const d of [tacit.decodeCXferBppPayload, tacit.decodeCXferPayload]) { try { const x = d(payload); if (x && x.outputs) return x; } catch { /* the other form */ } } return null; };

  async function open(tx, vout) {
    const key = `${tx.txid}:${vout}`;
    if (opened.has(key)) return opened.get(key);
    const note = await btc.resolveNote(tx.txid, vout);
    if (!note || strip(note.assetIdHex) !== strip(asset)) { opened.set(key, null); return null; }
    const env = tacit.txOutputEnvelope(tx), dec = env && decode(env.payload), first = tx.vin[1];
    if (!dec || !first || !dec.outputs[vout]) { opened.set(key, null); return null; }
    const anchorBytes = new Uint8Array([...hexToBytes(rev(first.txid)), first.vout & 0xff, (first.vout >>> 8) & 0xff, (first.vout >>> 16) & 0xff, (first.vout >>> 24) & 0xff]);
    const senderPubHex = first.witness && first.witness.length === 2 && first.witness[1].length === 66 ? first.witness[1] : null;
    const o = tacit.openTransferOutput({ priv: btc.wallet.priv, pub: btc.wallet.pub, senderPubHex, anchorBytes, vout, ct: dec.outputs[vout].encryptedAmount, commitment: note.commitment });
    const n = o ? { txid: tx.txid, vout, value: tx.vout[vout].value, amount: o.amount, blinding: o.blinding, height: tx.status.block_height } : null;
    opened.set(key, n);
    return n;
  }

  async function notes() {
    if (cache && now() - cache.at < ttlMs) return cache.notes;
    const out = [];
    for (const tx of await btc.history(btc.address, pages)) {
      if (!tx.status || !tx.status.confirmed) continue;
      for (let v = 0; v < tx.vout.length; v++) {
        if (strip(tx.vout[v].scriptpubkey) !== own) continue;
        const n = await open(tx, v);
        if (n && !(await btc.outspend(tx.txid, v))) out.push(n);
      }
    }
    cache = { at: now(), notes: out };
    return out;
  }
  return { notes, forget: () => { cache = null; } };
}

// The reflection's live set (GET /reflection/live on the Tacit API), read at most once a minute: a confirmed output in a
// block the reflection has passed is 'tracked' when live and 'untracked' when not; a later one is 'new'. burndep-ux
// noteTracking's answer, without the page.
export function makeReflectionTracking({ base, pool, fetchImpl = fetch, network = 'mainnet', ttlMs = 60000, now = () => Date.now() }) {
  let cache = null;
  async function live() {
    if (cache && now() - cache.at < ttlMs) return cache;
    const r = await fetchImpl(`${base.replace(/\/$/, '')}/reflection/live?network=${network}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`the reflection's live set: ${r.status}`);
    const j = await r.json();
    cache = { at: now(), height: Number(j.height), set: new Set((j.liveTriples || []).map((t) => String(t[0]).toLowerCase())), bound: new Set((j.liveTriples || []).filter((t) => Number(t[4]) === 1).map((t) => String(t[0]).toLowerCase())) };
    return cache;
  }
  return async (notes) => {
    const s = await live(), out = new Map();
    for (const n of notes) {
      const k = String(pool.outpointKey('0x' + rev(n.txid), Number(n.vout))).toLowerCase(), h = Number(n.height);
      out.set(`${n.txid}:${n.vout}`, s.set.has(k) ? (s.bound.has(k) ? 'bound' : 'tracked') : Number.isInteger(h) && h > 0 && h <= s.height ? 'untracked' : 'new');
    }
    return out;
  };
}
