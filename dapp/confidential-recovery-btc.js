// The Bitcoin-side inputs cBTC note recovery needs, from public esplora data and the wallet key alone: the outpoints the
// wallet has spent (each could have funded a lock's commit transaction, which anchors the note's blinding) and the outputs
// that could be a recorded cBTC lock. A lock is the output of a reveal transaction (a Taproot script-path spend) that pays
// the wallet's own key: the key-path P2TR current builds lock into, or the P2WPKH funding key older builds paid. Whether an
// output really is a lock is the pool's own record (cbtcLockVBtc), which the caller reads.
//
// Esplora is queried by script hash (the sha256 of the scriptPubKey, hex), so no address encoding is involved and
// the request names only a hash, never the key. Mirrors rotate on failure, as the lock driver's fetches do.

import { makeBtcWallet } from './bitcoin-taproot-wallet.js';
import { privBytes } from './confidential-recovery.js';

export const ESPLORA_BASES = [
  'https://mempool.space/api',
  'https://blockstream.info/api',
  'https://mempool.emzy.de/api',
];

const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

// A mirror that refused or failed is asked last for a while, by every provider in the page, and for longer each time it does
// so again: one that rate-limits this browser is left to forget it rather than asked again on each read.
const COOL = new Map();
const COOL_MS = 60_000, COOL_MAX_MS = 15 * 60_000;
function cool(base, ms) {
  const was = COOL.get(base), wait = Math.min(COOL_MAX_MS, Math.max(ms || COOL_MS, was ? was.wait * 2 : 0));
  COOL.set(base, { until: Date.now() + wait, wait });
}
const healthy = (bases) => { const now = Date.now(), down = (b) => (COOL.get(b)?.until || 0) > now; return [...bases].sort((a, b) => down(a) - down(b)); };
const retryAfterMs = (r) => { const s = Number(r && r.headers && typeof r.headers.get === 'function' && r.headers.get('retry-after')); return s > 0 ? s * 1000 : 0; };

// What the readers below use of a transaction, so a kept history is a fraction of esplora's size.
const slim = (t) => ({
  txid: t.txid,
  status: t.status ? { confirmed: !!t.status.confirmed, block_height: t.status.block_height, block_time: t.status.block_time } : undefined,
  vin: (t.vin || []).map((v) => ({ txid: v.txid, vout: v.vout, prevout: v.prevout ? { scriptpubkey: v.prevout.scriptpubkey, scriptpubkey_type: v.prevout.scriptpubkey_type, value: v.prevout.value } : null })),
  vout: (t.vout || []).map((o) => ({ scriptpubkey: o.scriptpubkey, scriptpubkey_type: o.scriptpubkey_type, value: o.value })),
});

export function makeBtcHistoryProvider({ fetchImpl, sha256, bases = ESPLORA_BASES, hrp = 'bc', timeoutMs = 8000, maxPages = 40, store = null } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('btc history: no fetch implementation');

  async function getJson(path) {
    let last;
    for (let pass = 0; pass < 2; pass++) {
      if (pass) await new Promise((res) => setTimeout(res, 750));
      for (const base of healthy(bases)) {
        let r;
        try { r = await f(base + path, { signal: AbortSignal.timeout(timeoutMs) }); }
        catch (e) { last = e; cool(base, 30_000); continue; }
        if (!r || !r.ok) {
          last = new Error(`esplora ${r && r.status}`);
          if (!r || r.status === 429 || r.status >= 500) cool(base, retryAfterMs(r));
          continue;
        }
        // a mirror's rate limit can come as a page of text with a 200
        try { const j = await r.json(); COOL.delete(base); return j; } catch (e) { last = e; cool(base); }
      }
    }
    throw last || new Error('esplora unavailable');
  }

  const scriptHash = (spk) => bytesToHex(Uint8Array.from(sha256(spk)));

  // Every transaction touching a script, newest first, in esplora's pages of 25 (confirmed pages continue from the last
  // confirmed txid).
  //
  // THROWS rather than truncating. These transactions are the `anchors` list, and anchors are the only input
  // to the cBTC blinding re-derivation — cBTC notes carry no memo at all, so key + chain is the sole channel
  // by which they can be found. Returning a short list on hitting the page cap therefore does not degrade
  // gracefully, it reports someone's BTC-backed balance as smaller than it is, with nothing anywhere saying
  // the history was cut off. A wallet busy enough to exceed the cap needs a higher `maxPages`, not a quietly
  // wrong answer.
  //
  // With a `store` (get/put by key), the confirmed part is kept: a later walk reads from the top only down to the newest
  // transaction it holds, so a visit costs a page rather than a page per 25 transactions. What is kept is always an unbroken
  // run from the newest confirmed transaction down; a walk that hits the cap keeps what it read and where it stopped (and
  // still throws), and the next walk carries on from there.
  async function txsOf(spk) {
    const h = scriptHash(spk), key = `btc-history|v1|${h}`;
    const kept = store ? await Promise.resolve().then(() => store.get(key)).catch(() => null) : null;
    const held = kept && kept.v === 1 && Array.isArray(kept.txs) ? kept.txs : [];
    const known = new Set(held.map((t) => t.txid));
    const capped = () => new Error(`btc history: script has more than ${maxPages * 25} transactions and the walk hit its page cap — `
      + 'refusing to return a truncated history (cBTC notes are derivable only from these anchors); '
      + 'raise maxPages and retry');
    const keep = (txs, done) => {
      if (!store) return;
      const confirmed = txs.filter((t) => t.status && t.status.confirmed);
      const from = done || !confirmed.length ? null : confirmed[confirmed.length - 1].txid;
      Promise.resolve().then(() => store.put(key, { v: 1, txs: confirmed, done: !!done, from })).catch(() => {});
    };
    const out = [];
    let pages = 0, joined = false, ended = false;
    let page = await getJson(`/scripthash/${h}/txs`);
    for (;;) {
      if (!Array.isArray(page) || !page.length) { ended = true; break; }
      if (pages++ >= maxPages) { keep(out, false); throw capped(); }
      for (const t of page) {
        if (known.size && t.status && t.status.confirmed && known.has(t.txid)) { joined = true; break; }
        out.push(slim(t));
      }
      if (joined) break;
      const confirmed = page.filter((t) => t.status && t.status.confirmed);
      if (page.length < 25 || !confirmed.length) { ended = true; break; }
      page = await getJson(`/scripthash/${h}/txs/chain/${confirmed[confirmed.length - 1].txid}`);
    }
    // the top reached the end without meeting what was kept (nothing kept, or a chain that changed under it): the walk stands alone
    if (!joined) { keep(out, ended); return out; }
    const whole = [...out, ...held];
    if (kept.done) { if (out.length) keep(whole, true); return whole; }
    // an earlier walk stopped short: carry it on from where it stopped
    let from = kept.from;
    while (from) {
      if (pages++ >= maxPages) { keep(whole, false); throw capped(); }
      const more = await getJson(`/scripthash/${h}/txs/chain/${from}`);
      if (!Array.isArray(more) || !more.length) break;
      whole.push(...more.map(slim));
      const confirmed = more.filter((t) => t.status && t.status.confirmed);
      if (more.length < 25 || !confirmed.length) break;
      from = confirmed[confirmed.length - 1].txid;
    }
    keep(whole, true);
    return whole;
  }

  // The wallet's funding and lock scripts, derived the way the lock driver derives them (cbtc-lock-mint.js).
  function walletScripts(priv) {
    const { wallet, prims } = makeBtcWallet({ priv: privBytes(priv), hrp, fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 1 });
    const { Q_xonly } = prims.tweakedOutputKey(wallet.xonly(), new Uint8Array(0));
    return { funding: prims.p2wpkhScript(wallet.pub), lock: prims.p2trScript(Q_xonly) };
  }

  // { anchors: [{ txid, vout }], lockOutputs: [{ txid, vout, value, spk }] } — displayed (big-endian) txids, as esplora
  // serves; `spk` is the script the output pays (the wallet's everyday one, or its lock script).
  async function history(priv) {
    const s = walletScripts(priv);
    const mine = new Set([bytesToHex(s.funding), bytesToHex(s.lock)]);
    const seen = new Map();
    for (const txs of await Promise.all([s.funding, s.lock].map((spk) => txsOf(spk)))) for (const t of txs) seen.set(t.txid, t);
    const anchors = [], lockOutputs = [];
    for (const t of seen.values()) {
      for (const v of t.vin || []) if (v.prevout && mine.has(String(v.prevout.scriptpubkey || '').toLowerCase())) anchors.push({ txid: v.txid, vout: v.vout });
      const revealShape = (t.vin || []).some((v) => v.prevout && v.prevout.scriptpubkey_type === 'v1_p2tr');
      if (!revealShape) continue;
      (t.vout || []).forEach((o, i) => { const spk = String(o.scriptpubkey || '').toLowerCase(); if (mine.has(spk)) lockOutputs.push({ txid: t.txid, vout: i, value: o.value, spk }); });
    }
    return { anchors, lockOutputs, txCount: seen.size };
  }

  // The wallet's cBTC locks, oldest first: each output paying its lock script above the dust band (cbtc-lock-mint.js's
  // DUST_FLOOR; the band below carries Tacit notes), with the note's blinding anchor, the first input of the commit
  // that the lock's reveal spends. A lock is the output of a reveal: it sits after output 0 and its transaction spends a
  // taproot output, so a plain payment to the same script is not listed as one. `spentBy` names the transaction that
  // spends a lock's output, when one does. Whether a lock is recorded, minted or retired is the pool's to say; the caller reads it.
  async function locks(priv) {
    const spk = walletScripts(priv).lock, want = bytesToHex(spk), out = [], txs = await txsOf(spk);
    // what spends each output of the lock script, mempool included: a lock taken back or redeemed is gone before the pool records it
    const spends = new Map();
    for (const t of txs) for (const v of t.vin || []) if (v.prevout && String(v.prevout.scriptpubkey || '').toLowerCase() === want) spends.set(`${v.txid}:${v.vout}`, t.txid);
    for (const t of txs) {
      const vout = (t.vout || []).findIndex((o) => String(o.scriptpubkey || '').toLowerCase() === want && Number(o.value) > LOCK_FLOOR);
      if (vout < 1 || !t.vin || !t.vin[0] || t.vin[0].prevout?.scriptpubkey_type !== 'v1_p2tr') continue;
      const commit = await getJson(`/tx/${t.vin[0].txid}`);
      if (!commit || !commit.vin || !commit.vin[0]) continue;
      out.push({
        lockTxid: t.txid, lockVout: vout, vBtc: String(t.vout[vout].value),
        anchor: { txid: commit.vin[0].txid, vout: commit.vin[0].vout }, at: ((t.status && t.status.block_time) || Date.now() / 1000) * 1000,
        ...(spends.has(`${t.txid}:${vout}`) ? { spentBy: spends.get(`${t.txid}:${vout}`) } : {}),
      });
    }
    return out.reverse();
  }

  return { history, txsOf, walletScripts, locks };
}

const LOCK_FLOOR = 546;
