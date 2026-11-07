// worker/src/burndep-live-tracer.js reads each hop's inputs the way the reflection guest does. An atomic settlement (what the taker
// of a Bitcoin order-book listing signs) lays its vins out as [the taker's commit, the seller's note, the taker's sats], so its
// kernel covers vin[1..1+count] and the funding follows the note; any other transfer takes every vin after its leading funding.
// The fixture is real mainnet: the purchase c654294c… (block 970,179, 1 asset input at vin 1, funding at vin 0 and vin 2), the
// split 683798fa… that made the seller's note (a leading funding input, then one note), and the funding transaction before it.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 } from '../node_modules/@noble/hashes/sha2.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeLiveBurnDepositTracer, traceBurnDepositProvenance, rebuiltRawTx } from '../worker/src/burndep-live-tracer.js';
import { makeBurnDepositTracer } from '../dapp/burn-deposit-tracer.js';

const FIX = JSON.parse(readFileSync(new URL('./fixtures/burndep-listing-purchase-2026-10-16.json', import.meta.url), 'utf8'));
// fbcd761a… is a real mainnet T_BTC_SPEND (0x6d): the exit of a TAC note from the Bitcoin shielded pool at block 972,152.
Object.assign(FIX, JSON.parse(readFileSync(new URL('./fixtures/pool-exit-tx-2026-11-07.json', import.meta.url), 'utf8')));
const id = (prefix) => Object.keys(FIX).find((k) => k.startsWith(prefix));
const PURCHASE = id('c654294c'), SPLIT = id('683798fa'), SPLIT_FUNDING = id('9981c2ea'), SPLIT_NOTE = id('57829e14');
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });

// An esplora that serves the fixture, with `patch` replacing a transaction's vin list; any other txid is a failed read.
function tracer({ patch = {}, kv = null } = {}) {
  const asked = [];
  const apiText = async (env, path) => {
    const m = /^\/tx\/([0-9a-f]{64})(\/hex)?$/.exec(path);
    const rec = m && FIX[m[1]];
    if (!rec) throw new Error(`no such transaction: ${path}`);
    asked.push(m[1]);
    if (m[2]) return rec.hex;
    const j = JSON.parse(rec.json);
    return JSON.stringify(patch[m[1]] ? { ...j, vin: patch[m[1]] } : j);
  };
  const t = makeLiveBurnDepositTracer({
    env: kv ? { REGISTRY_KV: kv } : {}, apiText, apiRawBytes: async () => { throw new Error('no blocks'); },
    network: 'mainnet', outpointKey: pool.outpointKey, sha256, fullBlockWitness: false,
  });
  return { t, asked };
}
const hopOf = async ({ t }, txid, vout) => t.getCxferByOutput(t.seed(txid, vout));
const vin = (txid, vout) => ({ txid, vout });

test('a listing purchase: the kernel covers the seller\'s note at vin 1, the skip is 1, and the taker\'s funding is never read', async () => {
  const x = tracer();
  const hop = await hopOf(x, PURCHASE, 0);
  assert.equal(hop.inputSkip, 1);
  assert.equal(hop.inputs.length, 1);
  assert.equal(hop.inputs[0].prevTxid, '0x' + SPLIT);
  assert.equal(hop.inputs[0].prevVout, 1);
  assert.match(hop.inputs[0].commitment, /^0x0[23][0-9a-f]{64}$/);
  // vin 0 (the commit) and vin 2 (the taker's sats) share one funding transaction, which a purchase's trace has no use for.
  assert.ok(!x.asked.includes(id('884ff6a7')), 'the funding transaction was read');
  assert.ok(x.asked.includes(SPLIT));
});

test('an ordinary transfer still skips its leading funding and carries every later input', async () => {
  const hop = await hopOf(tracer(), SPLIT, 3);
  assert.equal(hop.inputSkip, 1);
  assert.deepEqual(hop.inputs.map((i) => [i.prevTxid, i.prevVout]), [['0x' + SPLIT_NOTE, 0]]);
});

test('a listing purchase whose "asset input" is plain sats is refused', async () => {
  const x = tracer({ patch: { [PURCHASE]: [vin(SPLIT_FUNDING, 0), vin(SPLIT_FUNDING, 1), vin(SPLIT_FUNDING, 0)] } });
  await assert.rejects(hopOf(x, PURCHASE, 0), /atomic settlement whose asset input 1 .* is not a confidential note/);
});

test('a listing purchase that names more asset inputs than it has is refused', async () => {
  const x = tracer({ patch: { [PURCHASE]: [vin(SPLIT_FUNDING, 0)] } });
  await assert.rejects(hopOf(x, PURCHASE, 0), /naming 1 asset input\(s\) but has only 1 input/);
});

test('an ordinary transfer with funding after a note is still refused (the guest takes every input after the leading ones)', async () => {
  const x = tracer({ patch: { [SPLIT]: [vin(SPLIT_NOTE, 0), vin(SPLIT_FUNDING, 0)] } });
  await assert.rejects(hopOf(x, SPLIT, 3), /non-confidential input at index 1/);
});

test('a transfer that spends a shielded-pool exit is refused as the pool, not as a hop left unwritten', async () => {
  const EXIT = id('fbcd761a');
  const x = tracer({ patch: { [SPLIT]: [vin(SPLIT_FUNDING, 0), vin(EXIT, 0)] } });
  // The exit's envelope is opcode 0x6d, which the guest's own parse takes for no transfer.
  assert.equal((await x.t.resolveShallow(EXIT)).kind, 'unrecognized-envelope');
  await assert.rejects(hopOf(x, SPLIT, 3), (e) => {
    // burndep-ux reads the opcode out of this phrase; the wording around it is for whoever reads the answer.
    assert.match(e.message, new RegExp(`${EXIT}:0 carries an envelope .* resolvable leaf \\(opcode 0x6d\\)`));
    assert.match(e.message, /shielded-pool/);
    assert.match(e.message, /cannot be bridged/);
    assert.doesNotMatch(e.message, /CMINT|neither implemented/, 'a pool exit is not a CMINT or a bound hop');
    return true;
  });
});

test('a hop cached before the settlement shape was tracked reads the same as a fresh one', async () => {
  // The shallow record a deployed worker holds for the purchase has no assetInputCount.
  const fresh = tracer();
  const rec = await fresh.t.resolveShallow(PURCHASE);
  const { assetInputCount, ...old } = rec;
  assert.equal(assetInputCount, undefined);
  const kv = { get: async (k) => (k === `burndepshallow:mainnet:${PURCHASE}` ? old : null), put: async () => {} };
  const hop = await hopOf(tracer({ kv }), PURCHASE, 0);
  assert.equal(hop.inputSkip, 1);
  assert.deepEqual(hop.inputs.map((i) => [i.prevTxid, i.prevVout]), [['0x' + SPLIT, 1]]);
});

// maxDepth bounds the transfers in a lineage, not the outpoints the walk visits: the purchase, the split that made the seller's note, and
// the supply leaf (standing in for the etch) are three outpoints but two hops.
async function walk(maxDepth) {
  return traceBurnDepositProvenance({
    env: {}, network: 'mainnet', outpointKey: pool.outpointKey, sha256, maxDepth,
    trace: makeBurnDepositTracer({ outpointKey: pool.outpointKey }).trace,
    apiText: (env, path) => FIXTURE_API(path), apiRawBytes: async () => { throw new Error('no blocks'); },
    note: { txid: PURCHASE, vout: 0 }, leaves: [{ txid: SPLIT_NOTE, vout: 0 }],
  });
}
const FIXTURE_API = async (path) => {
  const m = /^\/tx\/([0-9a-f]{64})(\/hex)?$/.exec(path);
  const rec = m && FIX[m[1]];
  if (!rec) throw new Error(`no such transaction: ${path}`);
  return m[2] ? rec.hex : rec.json;
};
test('a lineage of two hops traces under a limit of two, and is refused under a limit of one', async () => {
  const res = await walk(2);
  assert.equal(res.cxfers.length, 2);
  assert.deepEqual(res.cxfers.map((c) => c.inputSkip), [1, 1]);
  await assert.rejects(walk(1), /exceeded maxDepth \(1\)/);
});

// One explorer request per transaction: its JSON, from which the raw bytes are rebuilt. Real mainnet transactions (a P2WPKH-homed
// reveal with a commit input, an atomic settlement with the taker's sats after the note) rebuild byte for byte, witness included.
// esplora-tx-json-2026-10-19.json: what mempool.bitaroo.net answered for /tx/<id> of four mainnet TAC transactions (a BP+ transfer,
// a classic transfer, an order-book settlement and a bridge burn), beside their raw hex.
const REAL = JSON.parse(readFileSync(new URL('./fixtures/esplora-tx-json-2026-10-19.json', import.meta.url), 'utf8'));
const dsha = (b) => sha256(sha256(b));
test('real esplora JSON rebuilds to the raw transaction byte for byte, witness included, and a wrong txid or a trimmed answer gets null', () => {
  assert.equal(Object.keys(REAL).length, 4);
  for (const [txid, rec] of Object.entries(REAL)) assert.equal(rebuiltRawTx(rec.json, txid, dsha), rec.hex, `${rec.kind} ${txid.slice(0, 8)} rebuilds`);
  const [txid, rec] = Object.entries(REAL)[0];
  assert.equal(rebuiltRawTx(rec.json, 'ff'.repeat(32), dsha), null);
  assert.equal(rebuiltRawTx({ ...rec.json, vin: [] }, txid, dsha), null);
  assert.equal(rebuiltRawTx(JSON.parse(FIX[PURCHASE].json), PURCHASE, dsha), null, 'the older fixture keeps only status and vin');
});

test('an answer whose segwit inputs come without their witnesses is not rebuilt (it would read a transfer as plain funding)', () => {
  for (const [txid, rec] of Object.entries(REAL)) {
    const bare = { ...rec.json, vin: rec.json.vin.map((v) => ({ ...v, witness: [] })) };
    assert.equal(rebuiltRawTx(bare, txid, dsha), null, `${rec.kind} ${txid.slice(0, 8)} without witnesses`);
  }
});

test('a non-transfer reading kept before this version is read again, and one kept now is not', async () => {
  const [txid, rec] = Object.entries(REAL).find(([, r]) => r.kind === '22');
  const store = new Map([[`burndepshallow:mainnet:${txid}`, JSON.stringify({ kind: 'funding' })]]), asked = [];
  const kv = { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null), put: async (k, v) => { store.set(k, v); } };
  const make = () => makeLiveBurnDepositTracer({
    env: { REGISTRY_KV: kv }, network: 'mainnet', outpointKey: pool.outpointKey, sha256, fullBlockWitness: false,
    apiText: async (env, path) => { asked.push(path); return path.endsWith('/hex') ? rec.hex : JSON.stringify(rec.json); },
    apiRawBytes: async () => { throw new Error('no blocks'); },
  });
  const healed = await make().resolveShallow(txid);
  assert.equal(healed.kind, 'cxfer', 'an old plain-funding reading of a real TAC transfer is read again and corrected');
  assert.equal(JSON.parse(store.get(`burndepshallow:mainnet:${txid}`)).v, 2);
  const n = asked.length;
  store.set(`burndepshallow:mainnet:${'ab'.repeat(32)}`, JSON.stringify({ kind: 'funding', v: 2 }));
  assert.equal((await make().resolveShallow('ab'.repeat(32))).kind, 'funding');
  assert.equal(asked.length, n, 'a reading kept at this version is used as it is');
});

// The older fixture keeps only status and vin; an esplora answer carries the rest, read here from the raw hex.
function esploraJsonOf(hex, kept) {
  const b = Buffer.from(hex.trim().replace(/^0x/, ''), 'hex');
  let p = 0;
  const u32 = () => { const v = b.readUInt32LE(p); p += 4; return v; };
  const vi = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b.readUInt16LE(p); p += 2; return v; } const v = b.readUInt32LE(p); p += 4; return v; };
  const take = (n) => { const v = b.subarray(p, p + n).toString('hex'); p += n; return v; };
  const version = u32();
  const segwit = b[p] === 0 && b[p + 1] === 1; if (segwit) p += 2;
  const vin = Array.from({ length: vi() }, () => ({ txid: Buffer.from(take(32), 'hex').reverse().toString('hex'), vout: u32(), scriptsig: take(vi()), sequence: u32() }));
  const vout = Array.from({ length: vi() }, () => { const value = Number(b.readBigUInt64LE(p)); p += 8; return { value, scriptpubkey: take(vi()) }; });
  if (segwit) for (const v of vin) v.witness = Array.from({ length: vi() }, () => take(vi()));
  return { ...kept, version, locktime: u32(), vin, vout };
}

test('the walk reads each transaction once and never asks for hex', async () => {
  const paths = [];
  await traceBurnDepositProvenance({
    env: {}, network: 'mainnet', outpointKey: pool.outpointKey, sha256, maxDepth: 4,
    trace: makeBurnDepositTracer({ outpointKey: pool.outpointKey }).trace,
    apiText: async (env, path) => {
      paths.push(path);
      const m = /^\/tx\/([0-9a-f]{64})$/.exec(path);
      return m ? JSON.stringify(esploraJsonOf(FIX[m[1]].hex, JSON.parse(FIX[m[1]].json))) : FIXTURE_API(path);
    },
    apiRawBytes: async () => { throw new Error('no blocks'); },
    note: { txid: PURCHASE, vout: 0 }, leaves: [{ txid: SPLIT_NOTE, vout: 0 }],
  });
  assert.ok(!paths.some((p) => p.endsWith('/hex')), `asked for hex: ${paths.join(' ')}`);
  assert.equal(new Set(paths).size, paths.length, `asked twice: ${paths.join(' ')}`);
});

test('a walk past its deadline stops with how far it got, and asked again over the same KV it finishes reading nothing twice', async () => {
  const store = new Map(), paths = [];
  const kv = { get: async (k) => (store.has(k) ? JSON.parse(store.get(k)) : null), put: async (k, v) => { store.set(k, v); } };
  const go = (deadline) => traceBurnDepositProvenance({
    env: { REGISTRY_KV: kv }, network: 'mainnet', outpointKey: pool.outpointKey, sha256, maxDepth: 4, deadline,
    trace: makeBurnDepositTracer({ outpointKey: pool.outpointKey }).trace,
    apiText: async (env, path) => { paths.push(path); await new Promise((r) => setTimeout(r, 30)); return FIXTURE_API(path); },
    apiRawBytes: async () => { throw new Error('no blocks'); },
    note: { txid: PURCHASE, vout: 0 }, leaves: [{ txid: SPLIT_NOTE, vout: 0 }],
  });
  const t0 = Date.now();
  let stopped;
  try { await go(t0 + 20); } catch (e) { stopped = e; }
  assert.equal(stopped && stopped.code, 'trace_pending', `stopped: ${stopped && stopped.message}`);
  assert.ok(Number.isInteger(stopped.hops) && stopped.hops >= 1 && stopped.hops < 2, `hops so far ${stopped.hops}`);
  const before = paths.length;
  const res = await go(Date.now() + 60_000);
  assert.equal(res.cxfers.length, 2);
  const again = paths.slice(before);
  assert.ok(again.every((p) => !paths.slice(0, before).includes(p)), `read again: ${again.join(' ')}`);
});
