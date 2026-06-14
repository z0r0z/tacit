// Build the genesis-bootstrap reflection fixture (reflection_input.json) for the first
// attestBitcoinStateProven of a freshly-deployed ConfidentialPool. The first batch is locked to
// start at the genesis anchor (anchorHeight) and must reach the matured relay tip, so it spans the
// whole gap as one full-scan batch. We fetch each signet block raw, split out every tx (segwit
// serialization, witness included — the guest strips it for the txid + reads it for envelopes), and
// run the dapp's assembleReflectionScanInput over the genesis ScanReflection state (empty pool, no
// effects → newDigest = genesis with height advanced).
//
// Usage:
//   node scripts/build-reflection-bootstrap-fixture.mjs <fromHeight> <toHeight> [outPath]
//   node scripts/build-reflection-bootstrap-fixture.mjs --probe <height>   # parse one block, print tx count
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';

const API = process.env.SIGNET_API || 'https://mempool.space/signet/api';
const sha256 = (b) => new Uint8Array(createHash('sha256').update(Buffer.from(b)).digest());
const _cat = (arrs) => { let n = 0; for (const a of arrs) n += a.length; const o = new Uint8Array(n); let i = 0; for (const a of arrs) { o.set(a, i); i += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(nobleSha256, key, _cat(m));

async function fetchRetry(url, { binary = false, tries = 5 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (!r.ok) { lastErr = new Error(`${r.status} ${url}`); await sleep(800 * (i + 1)); continue; }
      return binary ? new Uint8Array(await r.arrayBuffer()) : (await r.text()).trim();
    } catch (e) { lastErr = e; await sleep(800 * (i + 1)); }
  }
  throw lastErr;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const toHex = (u8) => Buffer.from(u8).toString('hex');

// ── minimal segwit-aware block splitter ──
// Returns { headerHex, txsHex: [fullRawTxHex,...] }. Splits by walking each tx's exact byte span.
function splitBlock(raw) {
  let o = 0;
  const u8 = raw;
  const readVarint = () => {
    const first = u8[o++];
    if (first < 0xfd) return first;
    if (first === 0xfd) { const v = u8[o] | (u8[o + 1] << 8); o += 2; return v; }
    if (first === 0xfe) { const v = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16) | (u8[o + 3] << 24); o += 4; return v >>> 0; }
    // 0xff: 8-byte (tx counts never need this, but handle it)
    let v = 0n; for (let i = 0; i < 8; i++) v |= BigInt(u8[o + i]) << BigInt(8 * i); o += 8; return Number(v);
  };
  const headerHex = toHex(u8.subarray(0, 80));
  o = 80;
  const txCount = readVarint();
  const txsHex = [];
  for (let t = 0; t < txCount; t++) {
    const start = o;
    o += 4; // version
    let segwit = false;
    if (u8[o] === 0x00 && u8[o + 1] === 0x01) { segwit = true; o += 2; } // marker+flag
    const vin = readVarint();
    for (let i = 0; i < vin; i++) {
      o += 36; // prev txid(32) + vout(4)
      const sl = readVarint(); o += sl; // scriptSig
      o += 4; // sequence
    }
    const vout = readVarint();
    for (let i = 0; i < vout; i++) {
      o += 8; // value
      const sl = readVarint(); o += sl; // scriptPubKey
    }
    if (segwit) {
      for (let i = 0; i < vin; i++) {
        const items = readVarint();
        for (let j = 0; j < items; j++) { const il = readVarint(); o += il; }
      }
    }
    o += 4; // locktime
    txsHex.push(toHex(u8.subarray(start, o)));
  }
  if (o !== u8.length) throw new Error(`block parse length mismatch: consumed ${o} of ${u8.length} (txCount=${txCount})`);
  return { headerHex, txsHex };
}

async function getBlock(h) {
  const hash = await fetchRetry(`${API}/block-height/${h}`);
  if (hash.length !== 64) throw new Error(`bad hash for ${h}: ${hash}`);
  const raw = await fetchRetry(`${API}/block/${hash}/raw`, { binary: true });
  const { headerHex, txsHex } = splitBlock(raw);
  return { h, hash, headerHex, txsHex };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--probe') {
    const h = parseInt(argv[1], 10);
    const b = await getBlock(h);
    console.log(`block ${h} hash=${b.hash}`);
    console.log(`  header=${b.headerHex.slice(0, 32)}… txCount=${b.txsHex.length}`);
    console.log(`  tx0 len=${b.txsHex[0].length / 2}B  txLast len=${b.txsHex.at(-1).length / 2}B`);
    return;
  }
  const from = parseInt(argv[0], 10), to = parseInt(argv[1], 10);
  const out = argv[2] || 'reflection_input.json';
  if (!(from > 0 && to >= from)) throw new Error('usage: <fromHeight> <toHeight> [outPath]');

  console.log(`fetching signet blocks ${from}..${to} (${to - from + 1} blocks) from ${API}`);
  const blocks = [];
  let totalTx = 0;
  for (let h = from; h <= to; h++) {
    const b = await getBlock(h);
    blocks.push(b);
    totalTx += b.txsHex.length;
    if ((h - from) % 10 === 0 || h === to) console.log(`  ${h}  txs=${b.txsHex.length}  (cumulative ${totalTx})`);
    await sleep(120);
  }
  console.log(`fetched ${blocks.length} blocks, ${totalTx} txs total`);

  const cp = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
  const state = cp.makeScanReflectionState();
  console.log(`genesis prior digest = ${state.digest()}`);

  const batch = {
    anchorHeight: from,
    headers: blocks.map((b) => b.headerHex),
    blocks: blocks.map((b) => ({ txs: b.txsHex.map((txData) => ({ txData, txid: null, vins: [], env: null })) })),
  };
  const fixture = cp.assembleReflectionScanInput(state, batch, new Map());
  console.log(`prior.height=${fixture.prior.height}  newDigest=${fixture.newDigest}`);
  console.log(`nonConserving=${fixture.nonConserving.length}  unreflectedValueEntry=${fixture.unreflectedValueEntry.length}`);

  writeFileSync(out, JSON.stringify(fixture));
  const bytes = Buffer.byteLength(JSON.stringify(fixture));
  console.log(`WROTE ${out}  (${(bytes / 1e6).toFixed(2)} MB, ${totalTx} txs)`);
}
main().catch((e) => { console.error('ERR', e); process.exit(1); });
