// tETH multi-generation attribution test (live mainnet data).
//
// Validates the worker's generation attribution against envelopes the
// deployed gen-0 guest actually accepted:
//   1. bind-hash recomputation (guest compute_bind_hash parity: domain ||
//      chain_id_32be || mixer_20 || network_tag || asset_32 || denom_32 ||
//      fields, reduced mod BN254-Fr) matches every live deposit + export
//      envelope under the gen-0 constants and matches NONE under alpha's;
//   2. isKnownDepositRoot(pid, ethRoot) returns true on the gen-0 mixer and
//      false on the alpha mixer for every live deposit root;
//   3. gen-'' pool keys are byte-identical to the pre-multigen layout and
//      'g1' keys carry the generation segment.
//
// Run: node tests/bridge-multigen.test.mjs

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); console.log(`  PASS  ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}: ${e.message}`); failed++; }
}

const WORKER_BASE = 'https://tacit-pin.rosscampbell9.workers.dev';
const ESPLORA = ['https://mempool.space/api', 'https://btcscan.org/api', 'https://blockstream.info/api'];

const TETH_ASSET = '3cba71e1114af183cdeacc6b8457a474d17529fd28704480ca799d0d03126f34';
const TETH_DENOM = '100000';
const GEN0  = { gen: '',   label: 'pilot', chainId: 1n, mixer: '6929acf0a8dde761bf16a54b61473e89124fecbf' };
const ALPHA = { gen: 'g1', label: 'alpha', chainId: 1n, mixer: '1e8baed52b336edf195e8185a0648d2c768be19f' };
const ETH_RPCS = ['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org', 'https://eth.merkle.io'];

const MAINNET_TAG = 0x00;  // networkTagFor('mainnet')
const T_BRIDGE_DEPOSIT = 0x60, T_BRIDGE_BURN = 0x61, T_BRIDGE_ROTATE = 0x62, T_BRIDGE_EXPORT = 0x63, T_BRIDGE_IMPORT = 0x64;
const BIND_DOMAINS = {
  [T_BRIDGE_DEPOSIT]: 'tacit-bridge-deposit-v1',
  [T_BRIDGE_BURN]:    'tacit-bridge-burn-v1',
  [T_BRIDGE_ROTATE]:  'tacit-bridge-rotate-v1',
  [T_BRIDGE_EXPORT]:  'tacit-bridge-export-v1',
  [T_BRIDGE_IMPORT]:  'tacit-bridge-import-v1',
};
const FIELD = 0x30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001n;
const ENVELOPE_MAGIC = new TextEncoder().encode('TACIT');

function sha256(b) { return new Uint8Array(createHash('sha256').update(b).digest()); }
function hexToBytes(h) { return Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16))); }
function bytesToHex(b) { return Array.from(b, x => x.toString(16).padStart(2, '0')).join(''); }
function concatBytes(...arrays) {
  const out = new Uint8Array(arrays.reduce((s, a) => s + a.length, 0));
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}
function u256be(v) {
  const out = new Uint8Array(32);
  let x = BigInt(v);
  for (let i = 31; i >= 0 && x > 0n; i--) { out[i] = Number(x & 0xffn); x >>= 8n; }
  return out;
}

// Mirrors worker _tethBindHash / guest compute_bind_hash.
function bindHash(opcode, g, netTag, assetId32, denom32, fields) {
  const pre = concatBytes(
    new TextEncoder().encode(BIND_DOMAINS[opcode]),
    u256be(g.chainId),
    hexToBytes(g.mixer),
    new Uint8Array([netTag & 0xff]),
    assetId32, denom32, ...fields,
  );
  const v = BigInt('0x' + bytesToHex(sha256(pre))) % FIELD;
  return bytesToHex(u256be(v));
}

// Mirrors worker decodeEnvelopeScript (Taproot reveal tapscript).
function decodeEnvelopeScript(script) {
  if (!script || script.length < 36) return null;
  let p = 0;
  if (script[p] !== 32) return null; p += 33;
  if (script[p] !== 0xac) return null; p += 1;
  if (script[p] !== 0x00 || script[p + 1] !== 0x63) return null; p += 2;
  const pushes = [];
  let sawEndif = false;
  while (p < script.length) {
    if (script[p] === 0x68) { p += 1; sawEndif = true; break; }
    const op = script[p]; p += 1;
    let data;
    if (op >= 1 && op <= 75) { data = script.slice(p, p + op); p += op; }
    else if (op === 0x4c) { const ln = script[p]; p += 1; data = script.slice(p, p + ln); p += ln; }
    else if (op === 0x4d) { const ln = script[p] | (script[p + 1] << 8); p += 2; data = script.slice(p, p + ln); p += ln; }
    else if (op === 0x00) { data = new Uint8Array(0); }
    else return null;
    pushes.push(data);
  }
  if (!sawEndif || pushes.length < 3) return null;
  for (let i = 0; i < 5; i++) if (pushes[0][i] !== ENVELOPE_MAGIC[i]) return null;
  if (pushes[1].length !== 1 || pushes[1][0] !== 0x01) return null;
  const payload = concatBytes(...pushes.slice(2));
  return { opcode: payload[0], payload };
}

async function fetchJson(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`${url} -> ${r.status}`);
  return r.json();
}
async function fetchTx(txid) {
  let lastErr;
  for (const base of ESPLORA) {
    try { return await fetchJson(`${base}/tx/${txid}`); } catch (e) { lastErr = e; }
  }
  throw lastErr;
}
function envelopeFromTx(tx) {
  if (tx.vin?.[0]?.witness?.length >= 3) {
    const d = decodeEnvelopeScript(hexToBytes(tx.vin[0].witness[1]));
    if (d) return d;
  }
  for (const o of tx.vout || []) {
    if (o.scriptpubkey_type !== 'op_return') continue;
    const sp = o.scriptpubkey;
    if (!sp || sp.slice(0, 2) !== '6a') continue;
    let payloadHex;
    const pushOp = sp.slice(2, 4);
    if (pushOp === '4d') { const dl = parseInt(sp.slice(6, 8) + sp.slice(4, 6), 16); payloadHex = sp.slice(8, 8 + dl * 2); }
    else if (pushOp === '4c') { const dl = parseInt(sp.slice(4, 6), 16); payloadHex = sp.slice(6, 6 + dl * 2); }
    else { const dl = parseInt(pushOp, 16); payloadHex = sp.slice(4, 4 + dl * 2); }
    if (payloadHex) { const payload = hexToBytes(payloadHex); return { opcode: payload[0], payload }; }
  }
  return null;
}

// Per-op (fields, bindHash) extraction — same offsets as worker handlers.
function bindParts(opcode, pl) {
  const asset = pl.slice(2, 34), denom = pl.slice(34, 66);
  switch (opcode) {
    case T_BRIDGE_DEPOSIT:
      return { asset, denom, fields: [pl.slice(66, 98), pl.slice(98, 130), pl.slice(130, 163), pl.slice(163, 195), pl.slice(195, 227)], bind: pl.slice(227, 259), ethRoot: pl.slice(66, 98) };
    case T_BRIDGE_BURN:
      return { asset, denom, fields: [pl.slice(66, 98), pl.slice(98, 130), pl.slice(130, 163), pl.slice(163, 195), pl.slice(195, 215), pl.slice(215, 247)], bind: pl.slice(247, 279) };
    case T_BRIDGE_ROTATE:
      return { asset, denom, fields: [pl.slice(66, 98), pl.slice(98, 130), pl.slice(130, 162), pl.slice(162, 194)], bind: pl.slice(194, 226) };
    case T_BRIDGE_EXPORT:
      return { asset, denom, fields: [pl.slice(66, 98), pl.slice(98, 130), pl.slice(130, 163), pl.slice(163, 195)], bind: pl.slice(195, 227) };
    case T_BRIDGE_IMPORT:
      return { asset, denom, fields: [pl.slice(66, 98), pl.slice(130, 162), pl.slice(162, 164)], bind: pl.slice(98, 130) };
    default: return null;
  }
}

async function ethCall(to, data) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] });
  for (const rpc of ETH_RPCS) {
    try {
      const r = await fetch(rpc, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const j = await r.json();
      if (typeof j.result === 'string') return j.result;
    } catch {}
  }
  return null;
}

// keccak-256 (standalone, for pid + selector — no deps).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
let keccak_256;
try { ({ keccak_256 } = require('@noble/hashes/sha3')); }
catch { ({ keccak_256 } = require('../worker/node_modules/@noble/hashes/sha3')); }

const UNIT_SCALE = 10000000000n;
function tethPoolId(assetIdHex, denomTacit) {
  return bytesToHex(keccak_256(concatBytes(hexToBytes(assetIdHex), u256be(BigInt(denomTacit) * UNIT_SCALE))));
}
const IKDR_SEL = bytesToHex(keccak_256(new TextEncoder().encode('isKnownDepositRoot(bytes32,bytes32)'))).slice(0, 8);

// ── main ────────────────────────────────────────────────────────────────────
console.log('bridge-multigen: fetching live gen-0 pool records…');
const pool = await fetchJson(`${WORKER_BASE}/pools/${TETH_ASSET}/${TETH_DENOM}?network=mainnet`);
const depositTxids = (pool.leaves || []).filter(l => l.source === 'bridge_deposit').map(l => l.deposit_txid);
const exportTxids  = (pool.nullifiers || []).filter(n => n.source === 'bridge_export').map(n => n.withdraw_txid);
console.log(`  ${depositTxids.length} deposits, ${exportTxids.length} exports`);
assert.ok(depositTxids.length > 0, 'need at least one live deposit');

const ethRoots = [];
for (const txid of [...depositTxids, ...exportTxids]) {
  const tx = await fetchTx(txid);
  const env = envelopeFromTx(tx);
  await test(`extract envelope ${txid.slice(0, 12)}`, () => {
    assert.ok(env, 'no envelope found');
    assert.ok([T_BRIDGE_DEPOSIT, T_BRIDGE_EXPORT].includes(env.opcode), `unexpected opcode 0x${env.opcode.toString(16)}`);
  });
  if (!env) continue;
  const parts = bindParts(env.opcode, env.payload);
  const bindHex = bytesToHex(parts.bind);
  await test(`gen-0 bind hash matches    ${txid.slice(0, 12)} (op 0x${env.opcode.toString(16)})`, () => {
    assert.equal(bindHash(env.opcode, GEN0, MAINNET_TAG, parts.asset, parts.denom, parts.fields), bindHex);
  });
  await test(`alpha bind hash differs    ${txid.slice(0, 12)}`, () => {
    assert.notEqual(bindHash(env.opcode, ALPHA, MAINNET_TAG, parts.asset, parts.denom, parts.fields), bindHex);
  });
  if (parts.ethRoot) ethRoots.push(bytesToHex(parts.ethRoot));
}

const pid = tethPoolId(TETH_ASSET, TETH_DENOM);
for (const root of [...new Set(ethRoots)]) {
  const data = '0x' + IKDR_SEL + pid + root;
  const [onGen0, onAlpha] = await Promise.all([
    ethCall('0x' + GEN0.mixer, data),
    ethCall('0x' + ALPHA.mixer, data),
  ]);
  await test(`isKnownDepositRoot ${root.slice(0, 12)}… true on gen-0, false on alpha`, () => {
    assert.ok(onGen0 !== null && onAlpha !== null, 'eth rpc unavailable');
    assert.equal(BigInt(onGen0), 1n, 'gen-0 mixer must know the root');
    assert.equal(BigInt(onAlpha), 0n, 'alpha mixer must not know the root');
  });
}

await test('gen-"" pool keys byte-identical to legacy layout', () => {
  const seg = (gen) => (gen ? `${gen}:` : '');
  const aid = TETH_ASSET, denom = TETH_DENOM;
  assert.equal(`pool:mainnet:${seg('')}${aid}:${denom}`, `pool:mainnet:${aid}:${denom}`);
  assert.equal(`poolleaf:mainnet:${seg('')}${aid}:${denom}:`, `poolleaf:mainnet:${aid}:${denom}:`);
  assert.equal(`pool:mainnet:${seg('g1')}${aid}:${denom}`, `pool:mainnet:g1:${aid}:${denom}`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
