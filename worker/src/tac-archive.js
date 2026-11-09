// Confirmed Tacit transactions kept as their exact bytes, by txid, so a page walking a note's history back to its etch reads that
// history from here in one answer instead of asking a public explorer for each transaction in it. The forward scan fills it from
// the blocks it reads, and an operator can import a list; a visitor never writes to it. A txid is the hash of a transaction's own
// bytes, so a reader checks every answer against the id it asked for, and what the page credits it still verifies itself.
//
// A second store holds the ordinary (no envelope) transactions that fund a Tacit transaction's extra inputs, which a page needs to
// know what such an input spends (dapp/tacit.js _stealthNeedsPrevout: an input with a witness of one or two items). They are
// kept apart from the Tacit transactions, so no reader of a history ever finds one where it expected a Tacit transaction, and
// they come back only to a caller that asks (`fund`). Nothing is imported by hand: catchUp() reads what is missing, a few
// transactions a tick, and so the archive keeps itself complete.

export const ARCHIVE_MAX_ROOTS = 64;
export const ARCHIVE_MAX_TXS = 4000;
export const ARCHIVE_MAX_IMPORT = 500;
const READ_CONCURRENCY = 32;
export const FUNDING_MAX_BYTES = 100_000;      // a funding transaction larger than this is left to the explorers

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
const toHex = (b) => { let s = ''; for (let i = 0; i < b.length; i++) s += HEX[b[i]]; return s; };
function fromHex(h) {
  const s = String(h).replace(/^0x/, '');
  if (s.length % 2 || /[^0-9a-f]/i.test(s)) return null;
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return b;
}

// A transaction's txid (display order, when `dsha256` is given), the txids its inputs spend, its first input's witness items
// (hex), and `needs`: the txids spent by inputs whose witness has one or two items (a key spend, the only inputs whose previous
// output a reader must know), from its raw bytes; null for bytes that are not one whole transaction.
export function parseTx(d, dsha256 = null) {
  try {
    let p = 0;
    const vi = () => {
      const f = d[p++];
      if (f < 0xfd) return f;
      if (f === 0xfd) { const v = d[p] | (d[p + 1] << 8); p += 2; return v; }
      if (f === 0xfe) { const v = (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16)) + d[p + 3] * 0x1000000; p += 4; return v; }
      let v = 0; for (let i = 0; i < 8; i++) v += d[p + i] * 2 ** (8 * i); p += 8; return v;
    };
    p = 4;
    const segwit = d[4] === 0 && d[5] === 1;
    if (segwit) p = 6;
    const nIn = vi();
    if (nIn < 1 || nIn > 10000) return null;
    const vins = [];
    for (let i = 0; i < nIn; i++) {
      vins.push(toHex(Uint8Array.from(d.subarray(p, p + 32)).reverse()));
      p += 36;
      const l = vi(); p += l + 4;
    }
    const nOut = vi();
    for (let i = 0; i < nOut; i++) { p += 8; const l = vi(); p += l; }
    const outEnd = p;
    let witness0 = null;
    const needs = [];
    if (segwit) {
      for (let i = 0; i < nIn; i++) {
        const n = vi(), items = [];
        for (let w = 0; w < n; w++) { const l = vi(); items.push(toHex(d.subarray(p, p + l))); p += l; }
        if (i === 0) witness0 = items;
        if (n === 1 || n === 2) needs.push(vins[i]);
      }
    }
    p += 4;
    if (p !== d.length) return null;
    let txid = null;
    if (dsha256) {
      const body = segwit ? concat(d.subarray(0, 4), d.subarray(6, outEnd), d.subarray(p - 4, p)) : d;
      txid = toHex(Uint8Array.from(dsha256(body)).reverse());
    }
    return { txid, vins, witness0, needs };
  } catch { return null; }
}
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
  let o = 0; for (const x of parts) { out.set(x, o); o += x.length; }
  return out;
}

export function makeTacArchive({ kv, network, dsha256, isTacit }) {
  if (!kv) throw new Error('tac-archive: kv required');
  const key = (txid) => `tacarch:${network}:${String(txid).toLowerCase()}`;
  const fundKey = (txid) => `tacfund:${network}:${String(txid).toLowerCase()}`;
  const doneKey = (txid) => `tacfund:done:${network}:${String(txid).toLowerCase()}`;

  // Keeps one confirmed transaction at `height`; returns its txid, or null for bytes that are not a whole transaction carrying a
  // Tacit envelope (the archive holds only those).
  async function keep(bytes, height, blockHash = null) {
    const d = typeof bytes === 'string' ? fromHex(bytes) : bytes;
    if (!d || !Number.isInteger(height) || height <= 0) return null;
    const t = parseTx(d, dsha256);
    if (!t || !isTacit(t.witness0)) return null;
    const rec = { hex: toHex(d), h: height };
    if (typeof blockHash === 'string' && /^[0-9a-f]{64}$/i.test(blockHash)) rec.b = blockHash.toLowerCase();
    await kv.put(key(t.txid), JSON.stringify(rec));
    return t.txid;
  }

  // Every archived transaction reached from `roots` through their inputs, roots included: { txs: Map txid -> { hex, h, b? },
  // truncated } (truncated when the walk stopped at `cap`). Reads storage only, a level at a time, at most `depth` levels past the
  // roots (0: the roots alone, for notes a reader already knows are valid and needs only their own transactions).
  async function ancestry(roots, { cap = ARCHIVE_MAX_TXS, depth = Infinity } = {}) {
    const out = new Map(), seen = new Set();
    let frontier = [...new Set((roots || []).map((r) => String(r).toLowerCase()))], truncated = false;
    for (let level = 0; frontier.length && !truncated && level <= depth; level++) {
      for (const id of frontier) seen.add(id);
      const got = [];
      for (let i = 0; i < frontier.length; i += READ_CONCURRENCY) {
        got.push(...await Promise.all(frontier.slice(i, i + READ_CONCURRENCY).map(async (id) => [id, await kv.get(key(id), 'json').catch(() => null)])));
      }
      const next = new Set();
      for (const [id, rec] of got) {
        if (!rec || typeof rec.hex !== 'string') continue;
        if (out.size >= cap) { truncated = true; break; }
        out.set(id, rec);
        const t = parseTx(fromHex(rec.hex));
        for (const v of (t && t.vins) || []) if (!seen.has(v)) next.add(v);
      }
      frontier = [...next];
    }
    return { txs: out, truncated };
  }

  // Keeps one confirmed ordinary transaction (any content) that funds an input of a Tacit transaction, in the second store; returns
  // its txid, or null for bytes that are not one whole transaction, one over FUNDING_MAX_BYTES, or a height of 0.
  async function keepFunding(bytes, height, blockHash = null) {
    const d = typeof bytes === 'string' ? fromHex(bytes) : bytes;
    if (!d || d.length > FUNDING_MAX_BYTES || !Number.isInteger(height) || height <= 0) return null;
    const t = parseTx(d, dsha256);
    if (!t || !t.txid) return null;
    const rec = { hex: toHex(d), h: height };
    if (typeof blockHash === 'string' && /^[0-9a-f]{64}$/i.test(blockHash)) rec.b = blockHash.toLowerCase();
    await kv.put(fundKey(t.txid), JSON.stringify(rec));
    return t.txid;
  }

  // The funding transactions behind `roots`: for each root in `txs` (an ancestry answer), the transactions its needed inputs spend
  // that the answer does not hold, as far as the second store holds them. Map txid -> { hex, h, b? }.
  async function fundingOf(txs, roots, { cap = 512 } = {}) {       // a page of 64 roots needs a couple of hundred; the cap bounds the store reads of one request
    const want = new Set();
    for (const r of new Set((roots || []).map((x) => String(x).toLowerCase()))) {
      const rec = txs.get(r);
      if (!rec) continue;
      const t = parseTx(fromHex(rec.hex));
      for (const p of (t && t.needs) || []) if (!txs.has(p)) want.add(p);
    }
    const ids = [...want].slice(0, cap), out = new Map();
    for (let i = 0; i < ids.length; i += READ_CONCURRENCY) {
      const got = await Promise.all(ids.slice(i, i + READ_CONCURRENCY).map(async (id) => [id, await kv.get(fundKey(id), 'json').catch(() => null)]));
      for (const [id, rec] of got) if (rec && typeof rec.hex === 'string') out.set(id, rec);
    }
    return out;
  }

  // Brings the archive up to date for `ids` (transfer txids from the index), at most `budget` reads from upstream: a transfer the archive
  // lacks is read and kept (if it carries an envelope), then each funding transaction its needed inputs spend that neither store holds is
  // read and kept, and the transfer is marked done. A marked transfer costs one store read, so a pass over what is complete is cheap and
  // a pass that stops for its budget starts again where the marks end. `readTx(txid)` gives { bytes, h, b } for a confirmed transaction,
  // { unconfirmed: true }, or null for one it could not read. Never throws.
  async function catchUp({ ids, readTx, budget = 40, shouldStop = () => false }) {
    const r = { checked: 0, done: 0, kept: 0, funding: 0, unconfirmed: 0, failed: 0, stopped: false };
    let reads = 0;
    const read = async (id) => { reads++; try { return await readTx(id); } catch { return null; } };
    for (const raw of ids || []) {
      const id = String(raw).toLowerCase();
      if (shouldStop()) { r.stopped = true; break; }
      try {
        if (await kv.get(doneKey(id))) { r.done++; continue; }
        r.checked++;
        let rec = await kv.get(key(id), 'json');
        if (!rec) {
          if (reads >= budget) { r.stopped = true; break; }
          const got = await read(id);
          if (!got) { r.failed++; continue; }
          if (got.unconfirmed) { r.unconfirmed++; continue; }
          const kept = await keep(got.bytes, got.h, got.b);
          if (kept !== id) { await kv.put(doneKey(id), '0', { expirationTtl: 7 * 86400 }); continue; }      // no envelope, or not the bytes asked for: look again in a week
          rec = await kv.get(key(id), 'json');
          r.kept++;
        }
        const t = rec && parseTx(fromHex(rec.hex));
        let retry = false, giveUp = !t;               // retry: a read that may work next pass; giveUp: one that will not (look again in a week)
        for (const p of [...new Set((t && t.needs) || [])]) {
          if ((await kv.get(key(p))) || (await kv.get(fundKey(p)))) continue;
          if (reads >= budget) { r.stopped = true; retry = true; break; }
          const got = await read(p);
          if (!got) { retry = true; r.failed++; continue; }
          if (got.unconfirmed) { retry = true; continue; }
          if ((await keepFunding(got.bytes, got.h, got.b)) === p) r.funding++; else giveUp = true;
        }
        if (!retry) await kv.put(doneKey(id), '1', giveUp ? { expirationTtl: 7 * 86400 } : undefined);
        if (r.stopped) break;
      } catch { r.failed++; }
    }
    return r;
  }

  return { key, fundKey, keep, keepFunding, ancestry, fundingOf, catchUp };
}
