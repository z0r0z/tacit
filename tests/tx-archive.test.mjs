#!/usr/bin/env node
// The page's side of the Tacit transaction archive (dapp/tx-archive.js): a transaction built from archived bytes reads, on every
// field a history walk and its two-source cross-check compare, exactly as esplora serves it; bytes that do not hash to the txid are
// dropped; a refused answer rests the archive instead of being asked again; a browser can turn it off.
//   node tests/tx-archive.test.mjs
import { readFileSync } from 'node:fs';
import { sha256 } from '@noble/hashes/sha256';
import { txFromRaw, makeTxArchive, TX_ARCHIVE_BURST, TX_ARCHIVE_REFILL_MS } from '../dapp/tx-archive.js';

let n = 0;
const ok = (c, m) => { if (c) { console.log('ok  -', m); n++; } else { console.error('FAIL -', m); process.exitCode = 1; } };
// The digest dapp/tacit.js compares between two sources before a purchase (_txFieldsOf), and the walk's own reads.
const fields = (t) => JSON.stringify({
  vin: (t.vin || []).map((i) => [String(i.txid).toLowerCase(), i.vout, (i.witness || []).map((w) => String(w).toLowerCase())]),
  vout: (t.vout || []).map((o) => [String(o.scriptpubkey).toLowerCase(), Number(o.value)]),
  height: t.status?.confirmed ? Number(t.status.block_height) : null,
});

// Four real TAC transactions (a BP+ transfer, a transfer, an atomic settlement and a bridge burn), each as esplora serves it and as
// its raw bytes.
const FIX = JSON.parse(readFileSync(new URL('./fixtures/esplora-tx-json-2026-10-19.json', import.meta.url), 'utf8'));
for (const [id, r] of Object.entries(FIX)) {
  const j = typeof r.json === 'string' ? JSON.parse(r.json) : r.json;
  const t = txFromRaw(r.hex, { txid: id, height: j.status.block_height, blockHash: j.status.block_hash, sha256 });
  ok(!!t && fields(t) === fields(j), `${r.kind} ${id.slice(0, 8)}: inputs, witnesses, outputs and height read as esplora's`);
  ok(t && t.vin.every((v, i) => v.sequence === j.vin[i].sequence && v.scriptsig === j.vin[i].scriptsig), `${id.slice(0, 8)}: and each input's sequence and script`);
  ok(t && t.vout.every((o, i) => o.scriptpubkey_type === j.vout[i].scriptpubkey_type) && t.version === j.version && t.locktime === j.locktime,
    `${id.slice(0, 8)}: and output types, version and locktime`);
  ok(t && t.status.block_hash === j.status.block_hash, `${id.slice(0, 8)}: and the block it is in`);
}
{
  const [id, r] = Object.entries(FIX)[0];
  const flip = r.hex.slice(0, 200) + (r.hex[200] === '0' ? '1' : '0') + r.hex.slice(201);
  ok(txFromRaw(flip, { txid: id, height: 970125, sha256 }) === null, 'bytes changed in an input or output no longer hash to the txid, and are dropped');
  ok(txFromRaw(r.hex, { txid: 'ab'.repeat(32), height: 970125, sha256 }) === null, 'and so are bytes offered under another txid');
  ok(txFromRaw(r.hex + '00', { txid: id, height: 970125, sha256 }) === null, 'or with bytes past the end');
}

// ── the client ──
{
  const ids = Object.keys(FIX), [a, b] = ids;
  const tamper = FIX[b].hex.slice(0, 120) + (FIX[b].hex[120] === 'f' ? 'e' : 'f') + FIX[b].hex.slice(121);
  let asked = 0, status = 200, t = 0;
  const fetchImpl = async (url, o) => {
    asked++;
    const body = JSON.parse(o.body);
    if (status !== 200) return { ok: false, status, headers: { get: () => null }, json: async () => ({ error: 'too many requests — retry in ~2s' }) };
    return { ok: true, status, json: async () => ({ txs: { [a]: { hex: FIX[a].hex, h: 970125 }, [b]: { hex: tamper, h: 951880 } }, truncated: false, roots: body.roots }) };
  };
  const store = { v: null, getItem: () => store.v };
  const sleeps = [];
  const arch = makeTxArchive({ burst: 1e9, base: 'https://api.test', network: 'mainnet', sha256, fetchImpl, storage: store, now: () => t, sleep: async (ms) => { sleeps.push(ms); } });
  await arch.prefetch([a, b]);
  ok(asked === 1 && arch.get(a) && !arch.get(b), 'one request for the history; the answer that checks is kept, the one that does not is dropped');
  ok(arch.get(a)._archived === true && arch.get(a).status.block_height === 970125, 'and what is kept says where it came from');
  const roots = Array.from({ length: 130 }, (_, i) => i.toString(16).padStart(64, '0'));
  asked = 0; await arch.prefetch(roots);
  ok(asked === 3, `130 roots are asked in batches of 64 (${asked} requests)`);
  status = 500; asked = 0;
  await arch.prefetch(['cd'.repeat(32)]); await arch.prefetch(['ce'.repeat(32)]);
  ok(asked === 1, 'a refused answer rests the archive: the next scan does not ask again');
  t += 11 * 60e3; status = 200; asked = 0;
  await arch.prefetch(['cf'.repeat(32)]);
  ok(asked === 1, 'and ten minutes on it is asked again');
  store.v = 'off'; asked = 0;
  await arch.prefetch(['d0'.repeat(32)]);
  ok(asked === 0, "a browser with 'tacit-tx-archive' set to off never asks it");
  ok(arch.get(a) === null, 'and is given nothing the archive already held');
  store.v = null;
  ok(!!arch.get(a), 'and has it back once it is turned on again');
}
// the API's own limit on how fast one address may ask: a 429 that says when to come back is waited for, and not taken for a failed archive
{
  const [a] = Object.keys(FIX);
  const answers = [429, 200], sleeps = []; let asked = 0;
  const fetchImpl = async (url, o) => {
    asked++;
    const st = answers.length ? answers.shift() : 200;
    if (st === 429) return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: 'too many requests — retry in ~2s' }) };
    return { ok: true, status: 200, json: async () => ({ txs: { [a]: { hex: FIX[a].hex, h: 970125 } }, truncated: false }) };
  };
  let c1 = 0;
  const arch = makeTxArchive({ base: 'https://api.test', network: 'mainnet', sha256, fetchImpl, storage: { getItem: () => null }, now: () => c1, sleep: async (ms) => { sleeps.push(ms); c1 += ms; } });
  await arch.prefetch([a]);
  ok(asked === 2 && arch.get(a), 'a 429 is waited out and the batch asked again, and the answer is kept');
  ok(sleeps.length === 1 && sleeps[0] === 2300, `the wait is what it said, ~2 s, and a little more (${sleeps[0]} ms)`);
  // many batches: a 429 empties the bucket, so the batch asked again and the ones after it wait for their tokens instead of meeting the limit again
  const ids = Array.from({ length: 200 }, (_, i) => (i + 1).toString(16).padStart(64, '0'));
  const s2 = [], seq = [429, 200, 200, 200, 200]; let n2 = 0, clock = 0;
  const arch2 = makeTxArchive({ burst: 3, refillMs: 15000, base: 'https://api.test', network: 'mainnet', sha256, storage: { getItem: () => null }, now: () => clock, sleep: async (ms) => { s2.push(ms); clock += ms; },
    fetchImpl: async () => { n2++; const st = seq.shift() ?? 200; return st === 429 ? { ok: false, status: 429, headers: { get: (h) => (h === 'retry-after' ? '3' : null) }, json: async () => ({}) } : { ok: true, status: 200, json: async () => ({ txs: {} }) }; } });
  await arch2.prefetch(ids);
  ok(n2 === 5, `200 roots are four batches, one asked twice (${n2} requests)`);
  ok(s2[0] === 3300, `a Retry-After of 3 s is waited (${JSON.stringify(s2)})`);
  ok(s2.slice(1).every((x) => x > 10000 && x <= 15100), `and each batch after it waits for its token, a refill (15 s) at most (${JSON.stringify(s2.slice(1))})`);
  // the bucket: a burst goes out at once, then one request every refill, whoever asks (two scans of a page share the archive and the API's limit)
  {
    let t = 0; const starts = [];
    const arch5 = makeTxArchive({ burst: 4, refillMs: 15000, base: 'https://api.test', network: 'mainnet', sha256, storage: { getItem: () => null }, now: () => t, sleep: async (ms) => { const until = t + ms; await Promise.resolve(); t = Math.max(t, until); },   // sleepers that wake together share one clock
      fetchImpl: async () => { starts.push(t); return { ok: true, status: 200, json: async () => ({ txs: {} }) }; } });
    const idsA = Array.from({ length: 256 }, (_, i) => (0x1000 + i).toString(16).padStart(64, '0')), idsB = Array.from({ length: 256 }, (_, i) => (0x2000 + i).toString(16).padStart(64, '0'));
    await Promise.all([arch5.prefetch(idsA), arch5.prefetch(idsB)]);
    ok(starts.length === 8 && starts.slice(0, 4).every((x) => x === 0), `eight batches from two scans at once: the first four (the burst) go out at once (${JSON.stringify(starts)})`);
    ok(starts.slice(4).every((x, i, a) => i === 0 || x - a[i - 1] >= 14000), `and the rest are a refill (15 s) apart, never closer (${JSON.stringify(starts.slice(4))})`);
  }
  ok(TX_ARCHIVE_BURST < 20 && TX_ARCHIVE_REFILL_MS === 15000, 'by default the bucket is under the API\'s own (a burst of 20, one more every 15 s)');
  // what is left of the bucket is kept in the browser, so a page loaded a moment after another does not take the burst again
  {
    let t = 1000; const kept = {}; const store2 = { getItem: (k) => kept[k] ?? null, setItem: (k, v) => { kept[k] = v; } };
    const mk = () => makeTxArchive({ burst: 4, refillMs: 15000, base: 'https://api.test', network: 'mainnet', sha256, storage: store2, now: () => t, sleep: async (ms) => { t += ms; },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ txs: {} }) }) });
    const idsC = Array.from({ length: 64 * 3 }, (_, i) => (0x3000 + i).toString(16).padStart(64, '0'));
    await mk().prefetch(idsC);                               // takes 3 of 4 tokens
    const t0 = t, sl = []; const again = makeTxArchive({ burst: 4, refillMs: 15000, base: 'https://api.test', network: 'mainnet', sha256, storage: store2, now: () => t, sleep: async (ms) => { sl.push(ms); t += ms; },
      fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ txs: {} }) }) });
    const idsD = Array.from({ length: 64 * 3 }, (_, i) => (0x4000 + i).toString(16).padStart(64, '0'));
    await again.prefetch(idsD);                              // one token is left, so the second and third batches wait
    ok(sl.length >= 2 && t - t0 >= 2 * 14000, `a second page (new archive object) finds the bucket nearly empty and waits for its tokens (${sl.length} waits, ${t - t0} ms)`);
  }
  // a limit that does not lift: three more tries, then it rests like any refusal
  let k = 0; let tt = 0;
  const arch3 = makeTxArchive({ base: 'https://api.test', network: 'mainnet', sha256, storage: { getItem: () => null }, now: () => tt, sleep: async (ms) => { tt += ms; },
    fetchImpl: async () => { k++; return { ok: false, status: 429, headers: { get: () => null }, json: async () => ({ error: 'retry in ~1s' }) }; } });
  await arch3.prefetch(['cd'.repeat(32)]); const first = k; await arch3.prefetch(['ce'.repeat(32)]);
  ok(first === 4 && k === 4, `a 429 that does not lift is asked four times in all, and the archive then rests (${first}, then ${k})`);
}
console.log(`${n} tx-archive checks passed${process.exitCode ? ' (with failures above)' : ''}`);
