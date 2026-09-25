// Raw Bitcoin block/tx parsing, Tacit envelope extraction (SPEC §3.1) and an esplora client for the
// shielded-pool indexer.

import { sha256, bytesToHex, hexToBytes, concat } from '../../../worker/src/btc-shielded-pool.js';

const sha256d = (b) => sha256(sha256(b));

function varint(d, p) {
  const f = d[p];
  if (f === undefined) throw new Error('truncated varint');
  if (f < 0xfd) return [f, 1];
  if (f === 0xfd) return [d[p + 1] | (d[p + 2] << 8), 3];
  if (f === 0xfe) return [(d[p + 1] | (d[p + 2] << 8) | (d[p + 3] << 16) | (d[p + 4] * 0x1000000)) >>> 0, 5];
  let n = 0;
  for (let i = 0; i < 8; i++) n += d[p + 1 + i] * 2 ** (8 * i);
  if (!Number.isSafeInteger(n)) throw new Error('varint too large');
  return [n, 9];
}
const u32le = (d, p) => (d[p] | (d[p + 1] << 8) | (d[p + 2] << 16) | (d[p + 3] * 0x1000000)) >>> 0;
const need = (d, p, n) => { if (p + n > d.length) throw new Error('truncated'); };

// One transaction starting at `start`. Returns { tx, end }. Byte fields are subarray views into `d`.
export function parseTx(d, start = 0) {
  let p = start;
  need(d, p, 4); p += 4;
  let segwit = false;
  if (d[p] === 0x00 && d[p + 1] === 0x01) { segwit = true; p += 2; }
  let n, l;
  [n, l] = varint(d, p); p += l;
  const vin = [];
  for (let i = 0; i < n; i++) {
    need(d, p, 36);
    const txid = bytesToHex(Uint8Array.from(d.subarray(p, p + 32)).reverse()); p += 32;
    const vout = u32le(d, p); p += 4;
    const [sl, sll] = varint(d, p); p += sll;
    need(d, p, sl + 4);
    p += sl + 4;
    vin.push({ txid, vout, witness: [] });
  }
  [n, l] = varint(d, p); p += l;
  const vout = [];
  for (let i = 0; i < n; i++) {
    need(d, p, 8);
    let value = 0n;
    for (let k = 7; k >= 0; k--) value = (value << 8n) | BigInt(d[p + k]);
    p += 8;
    const [sl, sll] = varint(d, p); p += sll;
    need(d, p, sl);
    vout.push({ value, scriptPubKey: d.subarray(p, p + sl) });
    p += sl;
  }
  const outEnd = p;
  if (segwit) {
    for (let i = 0; i < vin.length; i++) {
      const [wc, wl] = varint(d, p); p += wl;
      for (let w = 0; w < wc; w++) {
        const [il, ill] = varint(d, p); p += ill;
        need(d, p, il);
        vin[i].witness.push(d.subarray(p, p + il));
        p += il;
      }
    }
  }
  need(d, p, 4); p += 4;
  const stripped = segwit
    ? concat(d.subarray(start, start + 4), d.subarray(start + 6, outEnd), d.subarray(p - 4, p))
    : d.subarray(start, p);
  const txid = bytesToHex(sha256d(stripped).reverse());
  const wtxid = segwit ? sha256d(d.subarray(start, p)) : null;
  return { tx: { txid, vin, vout, segwit, wtxid }, end: p };
}

function merkleRoot(txidsInternal) {
  let level = txidsInternal;
  if (!level.length) throw new Error('empty block');
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(sha256d(concat(level[i], level[i + 1] || level[i])));
    level = next;
  }
  return level[0];
}

// BIP-141: the envelope lives in witness data, which the header's merkle root does not cover, so the
// coinbase witness commitment is checked too.
function checkWitnessCommitment(txs) {
  if (!txs.slice(1).some((t) => t.segwit)) return;
  const cb = txs[0];
  let commit = null;
  for (const o of cb.vout) {
    const s = o.scriptPubKey;
    if (s.length >= 38 && s[0] === 0x6a && s[1] === 0x24 && s[2] === 0xaa && s[3] === 0x21 && s[4] === 0xa9 && s[5] === 0xed) commit = s.subarray(6, 38);
  }
  const reserved = cb.vin[0] && cb.vin[0].witness[0];
  if (!commit || !reserved || reserved.length !== 32) throw new Error('segwit block without a witness commitment');
  const root = merkleRoot(txs.map((t, i) => (i === 0 ? new Uint8Array(32) : t.wtxid || hexToBytes(t.txid).reverse())));
  if (bytesToHex(sha256d(concat(root, reserved))) !== bytesToHex(commit)) throw new Error('witness commitment mismatch');
}

// Whole block. Checks the header hash against `expectHash` (display hex) when given, and the header's
// merkle root and witness commitment against the parsed transactions, so a source cannot hand back
// altered contents.
export function parseBlock(raw, expectHash = null) {
  const d = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (d.length < 81) throw new Error('block too short');
  const header = d.subarray(0, 80);
  const hash = bytesToHex(sha256d(header).reverse());
  if (expectHash && hash !== expectHash) throw new Error(`block hash ${hash} != expected ${expectHash}`);
  const prevHash = bytesToHex(Uint8Array.from(header.subarray(4, 36)).reverse());
  let p = 80;
  const [count, cl] = varint(d, p); p += cl;
  const txs = [];
  for (let i = 0; i < count; i++) {
    const { tx, end } = parseTx(d, p);
    txs.push(tx);
    p = end;
  }
  if (p !== d.length) throw new Error('trailing bytes after last tx');
  const mr = merkleRoot(txs.map((t) => hexToBytes(t.txid).reverse()));
  if (bytesToHex(mr) !== bytesToHex(header.subarray(36, 68))) throw new Error('merkle root mismatch');
  checkWitnessCommitment(txs);
  return { hash, prevHash, txs };
}

// SPEC §3.1 reveal: witness [sig, leaf_script, control_block]; the leaf script is
// <32-byte key> OP_CHECKSIG OP_FALSE OP_IF "TACIT" 0x01 <payload pushes…> OP_ENDIF.
// Mirrors decodeEnvelopeScript in dapp/tacit.js and worker/src/index.js.
const MAGIC = new TextEncoder().encode('TACIT');
export function decodeEnvelopeScript(script) {
  if (!script || script.length < 36) return null;
  let p = 0;
  if (script[p] !== 32) return null; p += 1;
  p += 32;
  if (p + 1 > script.length || script[p] !== 0xac) return null; p += 1;
  if (p + 2 > script.length || script[p] !== 0x00 || script[p + 1] !== 0x63) return null; p += 2;
  const pushes = [];
  let sawEndif = false;
  while (p < script.length) {
    if (script[p] === 0x68) { p += 1; sawEndif = true; break; }
    const op = script[p]; p += 1;
    let ln;
    if (op >= 1 && op <= 75) ln = op;
    else if (op === 0x4c) { if (p + 1 > script.length) return null; ln = script[p]; p += 1; }
    else if (op === 0x4d) { if (p + 2 > script.length) return null; ln = script[p] | (script[p + 1] << 8); p += 2; }
    else if (op === 0x00) ln = 0;
    else return null;
    if (p + ln > script.length) return null;
    pushes.push(script.subarray(p, p + ln)); p += ln;
  }
  if (!sawEndif || p !== script.length || pushes.length < 3) return null;
  if (pushes[0].length !== 5 || !MAGIC.every((c, i) => pushes[0][i] === c)) return null;
  if (pushes[1].length !== 1 || pushes[1][0] !== 0x01) return null;
  const payload = concat(...pushes.slice(2));
  if (!payload.length) return null;
  return { opcode: payload[0], payload };
}

function inputEnvelope(vin) {
  const w = vin && vin.witness;
  if (!w || w.length < 3) return null;
  return decodeEnvelopeScript(w[1]);
}

export function txEnvelope(tx) {
  return inputEnvelope(tx.vin[0]);
}

// The Tacit envelope on every input, null where there is none.
export function txEnvelopes(tx) {
  return tx.vin.map(inputEnvelope);
}

// ── esplora ──
export function makeEsplora(bases, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const list = (Array.isArray(bases) ? bases : String(bases).split(',')).map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (!list.length) throw new Error('no esplora base');
  // Throws on failure; the error carries notFound when every source answered 404.
  async function get(path, kind) {
    let lastErr, notFound = true;
    for (const base of list) {
      try {
        const r = await fetchImpl(base + path, { signal: AbortSignal.timeout(timeoutMs) });
        if (r.ok) return kind === 'bytes' ? new Uint8Array(await r.arrayBuffer()) : (await r.text()).trim();
        if (r.status !== 404) notFound = false;
        lastErr = new Error(`${base}${path} -> ${r.status}`);
      } catch (e) { notFound = false; lastErr = e; }
    }
    lastErr.notFound = notFound;
    throw lastErr;
  }
  return {
    tipHeight: async () => {
      const t = await get('/blocks/tip/height');
      if (!/^\d+$/.test(t)) throw new Error(`bad tip height ${t}`);
      return Number(t);
    },
    blockHash: async (h) => {
      const t = await get(`/block-height/${h}`);
      if (!/^[0-9a-f]{64}$/.test(t)) throw new Error(`bad block hash for ${h}`);
      return t;
    },
    rawBlock: (hash) => get(`/block/${hash}/raw`, 'bytes'),
    rawTx: async (txid) => hexToBytes(await get(`/tx/${txid}/hex`)),
    txStatus: async (txid) => JSON.parse(await get(`/tx/${txid}/status`)),
  };
}
