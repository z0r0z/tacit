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

export function makeBtcHistoryProvider({ fetchImpl, sha256, bases = ESPLORA_BASES, hrp = 'bc', timeoutMs = 8000, maxPages = 40 } = {}) {
  const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
  if (!f) throw new Error('btc history: no fetch implementation');

  async function getJson(path) {
    let last;
    for (let a = 0; a < bases.length * 2; a++) {
      const base = bases[a % bases.length];
      try {
        const r = await f(base + path, { signal: AbortSignal.timeout(timeoutMs) });
        if (!r || !r.ok) throw new Error(`esplora ${r && r.status}`);
        return await r.json();
      } catch (e) { last = e; await new Promise((res) => setTimeout(res, 200 * (a + 1))); }
    }
    throw last || new Error('esplora unavailable');
  }

  const scriptHash = (spk) => bytesToHex(Uint8Array.from(sha256(spk)));

  // Every transaction touching a script, newest first, in esplora's pages of 25 (confirmed pages continue from the last
  // confirmed txid).
  async function txsOf(spk) {
    const h = scriptHash(spk);
    const out = [];
    let page = await getJson(`/scripthash/${h}/txs`);
    for (let n = 0; n < maxPages && Array.isArray(page) && page.length; n++) {
      out.push(...page);
      const confirmed = page.filter((t) => t.status && t.status.confirmed);
      if (page.length < 25 || !confirmed.length) break;
      page = await getJson(`/scripthash/${h}/txs/chain/${confirmed[confirmed.length - 1].txid}`);
    }
    return out;
  }

  // The wallet's funding and lock scripts, derived the way the lock driver derives them (cbtc-lock-mint.js).
  function walletScripts(priv) {
    const { wallet, prims } = makeBtcWallet({ priv: privBytes(priv), hrp, fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 1 });
    const { Q_xonly } = prims.tweakedOutputKey(wallet.xonly(), new Uint8Array(0));
    return { funding: prims.p2wpkhScript(wallet.pub), lock: prims.p2trScript(Q_xonly) };
  }

  // { anchors: [{ txid, vout }], lockOutputs: [{ txid, vout, value }] } — displayed (big-endian) txids, as esplora serves.
  async function history(priv) {
    const s = walletScripts(priv);
    const mine = new Set([bytesToHex(s.funding), bytesToHex(s.lock)]);
    const seen = new Map();
    for (const spk of [s.funding, s.lock]) for (const t of await txsOf(spk)) seen.set(t.txid, t);
    const anchors = [], lockOutputs = [];
    for (const t of seen.values()) {
      for (const v of t.vin || []) if (v.prevout && mine.has(String(v.prevout.scriptpubkey || '').toLowerCase())) anchors.push({ txid: v.txid, vout: v.vout });
      const revealShape = (t.vin || []).some((v) => v.prevout && v.prevout.scriptpubkey_type === 'v1_p2tr');
      if (!revealShape) continue;
      (t.vout || []).forEach((o, i) => { if (mine.has(String(o.scriptpubkey || '').toLowerCase())) lockOutputs.push({ txid: t.txid, vout: i, value: o.value }); });
    }
    return { anchors, lockOutputs, txCount: seen.size };
  }

  return { history, txsOf, walletScripts };
}
