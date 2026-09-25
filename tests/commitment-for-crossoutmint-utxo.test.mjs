// commitmentForUtxo must resolve a T_CROSSOUT_MINT (0x65) note. Without it, an AMM POOL_INIT (or any
// other op) funded directly by a crossOut-mint note fails silently: ammCollectAssetInputs swallows the
// "unsupported envelope opcode" throw and returns an empty input set for that asset, so the op can never
// register. Real-world hit: a mainnet POOL_INIT funded by two crossOut-mint notes never appeared in
// /amm/pools despite the reveal tx confirming and scanForEtches's cursor passing its block.
// Offline: node tests/commitment-for-crossoutmint-utxo.test.mjs
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
const worker = await import('../worker/src/index.js');
let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) { console.log('  PASS  ' + n); pass++; } else { console.log('  FAIL  ' + n + (d ? ' - ' + d : '')); fail++; } };

const assetId = new Uint8Array(32).fill(0x11);
const claimId = new Uint8Array(32).fill(0x22);
const cx = new Uint8Array(32).fill(0x33);
const owner = new Uint8Array(32).fill(0x44);
// cy ending in an even byte (0x00) -> compressed prefix 0x02; a second case below flips it to odd (0x02) -> 0x03.
const cyEven = new Uint8Array(32).fill(0x55); cyEven[31] = 0x00;
const cyOdd = new Uint8Array(32).fill(0x55); cyOdd[31] = 0x01;

const payload = (cy) => new Uint8Array([0x65, ...assetId, ...claimId, ...cx, ...cy, ...owner]);
const xonly = new Uint8Array(32).fill(5);
// tapscript: <xonly> OP_CHECKSIG OP_FALSE OP_IF <"TACIT"> <0x01> <payload in one PUSHDATA2> OP_ENDIF
const env = (p) => bytesToHex(new Uint8Array([32, ...xonly, 0xac, 0x00, 0x63, 5, ...new TextEncoder().encode('TACIT'), 1, 1, 0x4d, p.length & 255, p.length >> 8, ...p, 0x68]));
const TXID = 'cd'.repeat(32);
const e = { REGISTRY_KV: { get: async () => null, put: async () => {}, delete: async () => {} } };

globalThis.fetch = async () => new Response(JSON.stringify({ txid: TXID, vin: [{ witness: ['00', env(payload(cyEven)), 'c0'] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const r0 = await worker.commitmentForUtxo(e, TXID, 0, 'mainnet');
ok('vout 0 resolves instead of throwing "unsupported envelope opcode"', !!r0);
ok('asset_id matches the envelope', r0.asset_id === bytesToHex(assetId));
ok('commitment is 33 bytes, even cy -> 0x02 prefix', r0.commitment === '02' + bytesToHex(cx));

globalThis.fetch = async () => new Response(JSON.stringify({ txid: TXID, vin: [{ witness: ['00', env(payload(cyOdd)), 'c0'] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
const r1 = await worker.commitmentForUtxo(e, TXID, 0, 'mainnet');
ok('odd cy -> 0x03 prefix', r1.commitment === '03' + bytesToHex(cx));

globalThis.fetch = async () => new Response(JSON.stringify({ txid: TXID, vin: [{ witness: ['00', env(payload(cyEven)), 'c0'] }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
let threw = false;
try { await worker.commitmentForUtxo(e, TXID, 1, 'mainnet'); } catch (x) { threw = /vout 0 only/.test(String(x.message)); }
ok('a vout other than 0 is rejected', threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
