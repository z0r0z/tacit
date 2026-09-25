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
  if (segwit && vin.every((i) => i.witness.length === 0)) throw new Error('superfluous witness marker');
  need(d, p, 4); p += 4;
  const stripped = segwit
    ? concat(d.subarray(start, start + 4), d.subarray(start + 6, outEnd), d.subarray(p - 4, p))
    : d.subarray(start, p);
  const txid = bytesToHex(sha256d(stripped).reverse());
  const wtxid = segwit ? sha256d(d.subarray(start, p)) : null;
  return { tx: { txid, vin, vout, segwit, wtxid }, end: p };
}

// Bitcoin Core's ComputeMerkleRoot, including its `mutated` flag: two equal siblings at any level mean the
// same root is reachable from a different transaction list.
function merkleRoot(txidsInternal) {
  let level = txidsInternal;
  if (!level.length) throw new Error('empty block');
  let mutated = false;
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      if (i + 1 < level.length && bytesToHex(level[i]) === bytesToHex(level[i + 1])) mutated = true;
      next.push(sha256d(concat(level[i], level[i + 1] || level[i])));
    }
    level = next;
  }
  return { root: level[0], mutated };
}

// BIP-141: the envelope lives in witness data, which the header's merkle root does not cover. The last
// coinbase output with the commitment prefix is the commitment; when present it is always checked, with a
// 32-byte reserved value as the coinbase's only witness item. Without one, no transaction may carry a witness.
function checkWitnessCommitment(txs) {
  const cb = txs[0];
  let commit = null;
  for (const o of cb.vout) {
    const s = o.scriptPubKey;
    if (s.length >= 38 && s[0] === 0x6a && s[1] === 0x24 && s[2] === 0xaa && s[3] === 0x21 && s[4] === 0xa9 && s[5] === 0xed) commit = s.subarray(6, 38);
  }
  if (!commit) {
    if (txs.some((t) => t.segwit)) throw new Error('witness data without a witness commitment');
    return;
  }
  const w = cb.vin.length === 1 ? cb.vin[0].witness : null;
  if (!w || w.length !== 1 || w[0].length !== 32) throw new Error('coinbase witness reserved value missing');
  const { root } = merkleRoot(txs.map((t, i) => (i === 0 ? new Uint8Array(32) : t.wtxid || hexToBytes(t.txid).reverse())));
  if (bytesToHex(sha256d(concat(root, w[0]))) !== bytesToHex(commit)) throw new Error('witness commitment mismatch');
}

// ── proof of work ──
// Compact nBits → target. Negative or overflowing encodings are invalid (Core's SetCompact).
export function bitsToTarget(bits) {
  const exp = bits >>> 24;
  const mant = BigInt(bits & 0x007fffff);
  if (bits & 0x00800000) throw new Error(`negative nBits ${bits.toString(16)}`);
  const t = exp <= 3 ? mant >> BigInt(8 * (3 - exp)) : mant << BigInt(8 * (exp - 3));
  if (t === 0n || t >= 1n << 256n) throw new Error(`nBits ${bits.toString(16)} out of range`);
  return t;
}
export function targetToBits(t) {
  let size = 0;
  for (let x = t; x > 0n; x >>= 8n) size++;
  let mant = size <= 3 ? t << BigInt(8 * (3 - size)) : t >> BigInt(8 * (size - 3));
  if (mant & 0x00800000n) { mant >>= 8n; size++; }
  return ((size << 24) | Number(mant)) >>> 0;
}
// Throws unless the header hash (display hex) meets nBits and nBits is no easier than the network limit.
export function checkProofOfWork(hash, bits, powLimitBits) {
  const target = bitsToTarget(bits);
  if (target > bitsToTarget(powLimitBits)) throw new Error(`nBits ${bits.toString(16)} above the proof-of-work limit`);
  if (BigInt('0x' + hash) > target) throw new Error(`block ${hash} does not meet its target`);
}
export const RETARGET_INTERVAL = 2016;
const RETARGET_TIMESPAN = 14 * 24 * 60 * 60;
// nBits required at a retarget height from the period's first and last header times (Core's
// CalculateNextWorkRequired, with its off-by-one period).
export function retargetBits(prevBits, firstTime, lastTime, powLimitBits) {
  let span = lastTime - firstTime;
  if (span < RETARGET_TIMESPAN / 4) span = RETARGET_TIMESPAN / 4;
  if (span > RETARGET_TIMESPAN * 4) span = RETARGET_TIMESPAN * 4;
  let t = (bitsToTarget(prevBits) * BigInt(span)) / BigInt(RETARGET_TIMESPAN);
  const limit = bitsToTarget(powLimitBits);
  if (t > limit) t = limit;
  return targetToBits(t);
}
// Mainnet and signet use the same retarget rule; signet blocks are additionally signed by the signet
// challenge, which this service does not verify.
export const CHAIN_PARAMS = {
  mainnet: { powLimitBits: 0x1d00ffff, checkpoint: null },
  signet: { powLimitBits: 0x1e0377ae, checkpoint: { height: 323600, hash: '00000001c87e047fc02715b367a7799b372cd92910c73a7fc25b5d020ef2471c' } },
};

export function parseHeader(h) {
  if (!h || h.length !== 80) throw new Error('header must be 80 bytes');
  return {
    hash: bytesToHex(sha256d(h).reverse()),
    prevHash: bytesToHex(Uint8Array.from(h.subarray(4, 36)).reverse()),
    time: u32le(h, 68),
    bits: u32le(h, 72),
  };
}

// Whole block. Checks the header hash against `expectHash` (display hex) when given, and the header's
// merkle root and witness commitment against the parsed transactions, so a source cannot hand back
// altered contents. Proof of work and chain linkage are the caller's.
export function parseBlock(raw, expectHash = null) {
  const d = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
  if (d.length < 81) throw new Error('block too short');
  const header = d.subarray(0, 80);
  const { hash, prevHash, time, bits } = parseHeader(header);
  if (expectHash && hash !== expectHash) throw new Error(`block hash ${hash} != expected ${expectHash}`);
  let p = 80;
  const [count, cl] = varint(d, p); p += cl;
  const txs = [];
  for (let i = 0; i < count; i++) {
    const { tx, end } = parseTx(d, p);
    txs.push(tx);
    p = end;
  }
  if (p !== d.length) throw new Error('trailing bytes after last tx');
  if (!txs.length || !isCoinbase(txs[0])) throw new Error('first transaction is not a coinbase');
  if (txs.slice(1).some(isCoinbase)) throw new Error('more than one coinbase');
  if (new Set(txs.map((t) => t.txid)).size !== txs.length) throw new Error('duplicate transaction');
  const mr = merkleRoot(txs.map((t) => hexToBytes(t.txid).reverse()));
  if (mr.mutated) throw new Error('mutated merkle tree');
  if (bytesToHex(mr.root) !== bytesToHex(header.subarray(36, 68))) throw new Error('merkle root mismatch');
  checkWitnessCommitment(txs);
  return { hash, prevHash, time, bits, header: Uint8Array.from(header), txs };
}

const NULL_TXID = '00'.repeat(32);
const isCoinbase = (tx) => tx.vin.length === 1 && tx.vin[0].txid === NULL_TXID && tx.vin[0].vout === 0xffffffff;

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
// `hashQuorum` > 1 asks every source for a height's block hash and requires that many to agree, with none
// disagreeing.
export function makeEsplora(bases, { fetchImpl = fetch, timeoutMs = 20000, hashQuorum = 1 } = {}) {
  const list = (Array.isArray(bases) ? bases : String(bases).split(',')).map((s) => s.trim().replace(/\/$/, '')).filter(Boolean);
  if (!list.length) throw new Error('no esplora base');
  if (!Number.isInteger(hashQuorum) || hashQuorum < 1 || hashQuorum > list.length) throw new Error(`hash quorum ${hashQuorum} needs as many esplora bases`);
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
      if (hashQuorum === 1) {
        const t = await get(`/block-height/${h}`);
        if (!/^[0-9a-f]{64}$/.test(t)) throw new Error(`bad block hash for ${h}`);
        return t;
      }
      const answers = await Promise.all(list.map(async (base) => {
        try {
          const r = await fetchImpl(`${base}/block-height/${h}`, { signal: AbortSignal.timeout(timeoutMs) });
          const t = r.ok ? (await r.text()).trim() : null;
          return t && /^[0-9a-f]{64}$/.test(t) ? t : null;
        } catch { return null; }
      }));
      const got = answers.filter(Boolean);
      if (new Set(got).size > 1) throw new Error(`esplora sources disagree on block ${h}`);
      if (got.length < hashQuorum) throw new Error(`block ${h}: ${got.length} of ${hashQuorum} sources answered`);
      return got[0];
    },
    header: async (hash) => hexToBytes(await get(`/block/${hash}/header`)),
    rawBlock: (hash) => get(`/block/${hash}/raw`, 'bytes'),
    rawTx: async (txid) => hexToBytes(await get(`/tx/${txid}/hex`)),
    txStatus: async (txid) => JSON.parse(await get(`/tx/${txid}/status`)),
  };
}
