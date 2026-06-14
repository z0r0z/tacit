#!/usr/bin/env node
// Maestro esplora compatibility check (mainnet). Verifies the endpoints + JSON
// fields the cron scan depends on are byte-identical to blockstream, so the
// indexer can trust Maestro as its primary source. Reads MAESTRO_API_KEY from
// the environment or a gitignored .env.render / .env.tacit-api-render — the key
// is never printed.
//
//   node scripts/maestro-check.mjs
//
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnvFile } from './env.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAESTRO = 'https://xbt-mainnet.gomaestro-api.org/v0/esplora';
const BLOCKSTREAM = 'https://blockstream.info/api';

function loadKey() {
  if (process.env.MAESTRO_API_KEY) return process.env.MAESTRO_API_KEY.trim();
  for (const f of ['.env.render', '.env.tacit-api-render', '.env.mainnet', '.env']) {
    const v = parseEnvFile(path.join(ROOT, f))?.MAESTRO_API_KEY;
    if (v) return v.trim();
  }
  return null;
}

const KEY = loadKey();
if (!KEY) {
  console.error('No MAESTRO_API_KEY found. Append `MAESTRO_API_KEY=<key>` to .env.render (gitignored), then re-run.');
  process.exit(2);
}

const mh = { 'api-key': KEY };
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => { (cond ? pass++ : fail++); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`); };

async function jget(base, path, headers) {
  let lastErr;
  for (let i = 0; i < 4; i++) {
    if (i) await new Promise(r => setTimeout(r, 600 * i));
    try {
      const r = await fetch(`${base}${path}`, { headers, signal: AbortSignal.timeout(15000) });
      const text = await r.text();
      let json = null; try { json = JSON.parse(text); } catch {}
      return { status: r.status, text, json };
    } catch (e) { lastErr = e; }
  }
  return { status: 0, text: `fetch failed: ${lastErr?.message || 'unknown'}`, json: null };
}

// Fetch the same path from both providers in parallel.
const both = (path) => Promise.all([jget(MAESTRO, path, mh), jget(BLOCKSTREAM, path, {})]);

// The fields scanForEtches reads off each tx (keep in sync with its tx-field
// reads in worker/src/index.js). We assert they exist on Maestro AND match
// blockstream for the same tx (structure + values).
function txShape(tx) {
  return {
    txid: tx.txid,
    nVin: Array.isArray(tx.vin) ? tx.vin.length : -1,
    nVout: Array.isArray(tx.vout) ? tx.vout.length : -1,
    vin0HasWitness: !!(tx.vin?.[0] && 'witness' in tx.vin[0]),
    vin0HasPrevout: !!(tx.vin?.[0] && 'prevout' in tx.vin[0]),
    vout0Spk: tx.vout?.[0]?.scriptpubkey ?? null,
    vout0Val: tx.vout?.[0]?.value ?? null,
    confirmed: tx.status?.confirmed ?? null,
    blockHeight: tx.status?.block_height ?? null,
  };
}

(async () => {
  console.log('— Maestro esplora compatibility (mainnet) —\n');

  // 1. tip height (auth works + path valid)
  const tip = await jget(MAESTRO, '/blocks/tip/height', mh);
  const tipH = parseInt(String(tip.text).trim(), 10);
  ok('GET /blocks/tip/height (auth + path)', tip.status === 200 && Number.isInteger(tipH), `status=${tip.status} tip=${Number.isInteger(tipH) ? tipH : tip.text.slice(0, 60)}`);
  if (tip.status === 402) { console.log('\n  → 402 = key not accepted. Check the key value / that the Esplora API is enabled on this Maestro project.'); process.exit(1); }
  if (!Number.isInteger(tipH)) process.exit(1);

  // Use a settled block (tip-6) so both providers have identical, final data.
  const H = tipH - 6;

  // 2. block-height -> hash, both providers agree
  const [mHash, bHash] = await both(`/block-height/${H}`);
  ok(`GET /block-height/${H} matches blockstream`, mHash.status === 200 && mHash.text.trim() === bHash.text.trim(), `maestro=${mHash.text.trim().slice(0, 16)}… blockstream=${bHash.text.trim().slice(0, 16)}…`);
  const hash = mHash.text.trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) process.exit(1);

  // 3. /block/<hash>/txs/0 — same txid set + order as blockstream
  const [mTxs, bTxs] = await both(`/block/${hash}/txs/0`);
  const mIds = Array.isArray(mTxs.json) ? mTxs.json.map(t => t.txid) : [];
  const bIds = Array.isArray(bTxs.json) ? bTxs.json.map(t => t.txid) : [];
  const sameOrder = mIds.length === bIds.length && mIds.every((x, i) => x === bIds[i]);
  ok('GET /block/<hash>/txs/0 — txid set+order == blockstream', sameOrder, `maestro=${mIds.length} blockstream=${bIds.length} txs`);

  // 4. Per-tx field shapes match (the fields the scan parses)
  if (Array.isArray(mTxs.json) && Array.isArray(bTxs.json) && mTxs.json.length) {
    const sample = [...new Set([0, 1, mTxs.json.length - 1])].filter((v) => v < mTxs.json.length);
    let shapeOk = true, detail = '';
    for (const idx of sample) {
      const mShape = JSON.stringify(txShape(mTxs.json[idx]));
      const bMatch = bTxs.json.find(t => t.txid === mTxs.json[idx].txid);
      const bShape = bMatch ? JSON.stringify(txShape(bMatch)) : '(missing)';
      if (mShape !== bShape) { shapeOk = false; detail = `tx[${idx}] maestro=${mShape} vs blockstream=${bShape}`; break; }
    }
    ok('tx fields (txid/vin/vout/witness/prevout/scriptpubkey/value/status) match', shapeOk, detail);
  }

  // 5. /tx/<txid> single fetch shape
  const someTxid = mIds[Math.min(1, mIds.length - 1)];
  const [mTx, bTx] = await both(`/tx/${someTxid}`);
  ok('GET /tx/<txid> shape matches', mTx.status === 200 && bTx.status === 200 && JSON.stringify(txShape(mTx.json)) === JSON.stringify(txShape(bTx.json)));

  console.log(`\n${fail === 0 ? '✅ ALL PASS' : '❌ ' + fail + ' FAILED'} — ${pass} passed, ${fail} failed.`);
  if (fail === 0) console.log('Maestro is a safe drop-in primary for the mainnet scan. Set MAESTRO_API_KEY on Render + deploy.');
  process.exit(fail === 0 ? 0 : 1);
})().catch(e => { console.error('check crashed:', e.message); process.exit(3); });
