// parseRawBlockTxs (the primary path streamBlockTxsBest/scanForEtches use to read a block) must populate
// each input's own prevout (txid + vout) — not just walk past its bytes. Without this, ammCollectAssetInputs
// (and anything else that resolves a funding input by tx.vin[i].{txid,vout}) finds nothing for EVERY
// raw-block-scanned tx, since `{}` has neither field. Real-world hit: a mainnet AMM POOL_INIT confirmed and
// was scanned past, but never registered in /amm/pools — /debug/poolinit (which fetches the tx via the
// single-tx esplora JSON endpoint, carrying real vin.txid/vout) said every gate passed, while the actual
// cron scan (raw-block path) could never resolve the funding inputs at all.
// Offline: node tests/parse-raw-block-vin-prevout.test.mjs
import { bytesToHex, hexToBytes, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
const worker = await import('../worker/src/index.js');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };

const W = () => {
  const chunks = [];
  return {
    push: (b) => { chunks.push(b); return W_api; },
    u32: (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); chunks.push(b); },
    u64: (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); chunks.push(b); },
    varint: (n) => { chunks.push(n < 0xfd ? new Uint8Array([n]) : (() => { const b = new Uint8Array(3); b[0] = 0xfd; new DataView(b.buffer).setUint16(1, n, true); return b; })()); },
    out: () => concatBytes(...chunks),
  };
};
const W_api = {};

// One segwit tx, 2 plain inputs (distinct prevout txid/vout), 1 output, no witness data on either input
// (irrelevant to this test — only prevout parsing is under test).
const prevTxidA = new Uint8Array(32).fill(0xaa); // display-order txid
const prevTxidB = new Uint8Array(32).fill(0xbb);
function buildTx() {
  const w = W();
  w.u32(2); // version
  w.push(new Uint8Array([0x00, 0x01])); // segwit marker+flag
  w.varint(2); // vin count
  w.push(Uint8Array.from(prevTxidA).reverse()); w.u32(7);   w.varint(0); // scriptSig len 0
  w.u32(0xfffffffd); // sequence
  w.push(Uint8Array.from(prevTxidB).reverse()); w.u32(3);   w.varint(0);
  w.u32(0xfffffffd);
  w.varint(1); // vout count
  w.u64(1000); w.varint(1); w.push(new Uint8Array([0x51])); // trivial 1-byte script
  // witness: 0 items for each input (still present since segwit flag is set)
  w.varint(0); w.varint(0);
  w.u32(0); // locktime
  return w.out();
}
function buildBlock(txBytes) {
  const w = W();
  w.push(new Uint8Array(80)); // header (zeroed — parseRawBlockTxs only reads bytes 68..72 for block_time, fine as 0)
  w.varint(1); // tx count
  w.push(txBytes);
  return w.out();
}

const block = buildBlock(buildTx());
const txs = [...worker.parseRawBlockTxs(block)];
ok('parses exactly one tx', txs.length === 1);
const tx = txs[0];
ok('vin[0].txid matches the real prevout (not empty)', tx.vin[0].txid === bytesToHex(prevTxidA), tx.vin[0].txid);
ok('vin[0].vout matches', tx.vin[0].vout === 7, String(tx.vin[0].vout));
ok('vin[1].txid matches the second input\'s own distinct prevout', tx.vin[1].txid === bytesToHex(prevTxidB), tx.vin[1].txid);
ok('vin[1].vout matches', tx.vin[1].vout === 3, String(tx.vin[1].vout));
ok('vout still parses correctly alongside the fix', tx.vout.length === 1 && tx.vout[0].value === 1000);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
