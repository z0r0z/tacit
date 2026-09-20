// commitmentForUtxo must resolve the outputs of a generation-bound CXFER (0x39). Without it, a bound tETH note could not be listed on the
// orderbook: the worker answered "commitment lookup failed: unsupported envelope opcode".
// Offline: node tests/commitment-for-bound-utxo.test.mjs
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
const worker = await import('../worker/src/index.js');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };

const asset = new Uint8Array(32).fill(0x3c), target = new Uint8Array(32).fill(0x38), sig = new Uint8Array(64).fill(1);
const c0 = new Uint8Array(33).fill(2), c1 = new Uint8Array(33).fill(3), ct = new Uint8Array(8).fill(9), rp = new Uint8Array(40).fill(7);
const wire = (n) => { const outs = [c0, c1].slice(0, n).flatMap((c) => [c, ct]); const rl = new Uint8Array([rp.length & 255, rp.length >> 8]);
  return new Uint8Array([0x39, ...target, ...asset, ...sig, n, ...outs.flatMap((x) => [...x]), ...rl, ...rp]); };
const xonly = new Uint8Array(32).fill(5);
// tapscript: <xonly> OP_CHECKSIG OP_FALSE OP_IF <"TACIT"> <0x01> <payload in one PUSHDATA2> OP_ENDIF (the wire the worker's decoder reads)
const env = (payload) => bytesToHex(new Uint8Array([32, ...xonly, 0xac, 0x00, 0x63, 5, ...new TextEncoder().encode('TACIT'), 1, 1, 0x4d, payload.length & 255, payload.length >> 8, ...payload, 0x68]));
const TXID = 'ab'.repeat(32);
globalThis.fetch = async (u) => new Response(JSON.stringify({ txid: TXID, vin: [{ witness: ['00', env(wire(2)), 'c0'] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const e = { REGISTRY_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };

const r0 = await worker.commitmentForUtxo(e, TXID, 0, 'mainnet');
ok('output 0 resolves to its commitment', r0.commitment === bytesToHex(c0));
ok('and to the asset id in the envelope', r0.asset_id === bytesToHex(asset));
const r1 = await worker.commitmentForUtxo(e, TXID, 1, 'mainnet');
ok('output 1 resolves too', r1.commitment === bytesToHex(c1));
let threw = false; try { await worker.commitmentForUtxo(e, TXID, 2, 'mainnet'); } catch (x) { threw = /out of range/.test(String(x.message)); }
ok('an output past the last one is rejected', threw);
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
