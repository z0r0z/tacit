// PR3: /finalize endpoint + sequential broadcast for T_AXFER_VAR.
//
// Exercises the state-machine guards on /finalize without invoking real
// Bitcoin broadcast. Happy-path (commit + reveal both broadcast, fulfilment
// transitions COMMIT_READY → REVEAL_BROADCAST) is covered by the signet e2e
// harness that lands alongside the dapp builder. Here we pin the rejection
// paths that fail BEFORE any /tx POST goes out, plus the new
// decodeAxferVarPayload structural decoder.
//
// What this pins down:
//   1. decodeAxferVarPayload mirrors the dapp decoder byte-for-byte:
//      asset_input_count must be exactly 1, N must be exactly 2.
//   2. /finalize rejects:
//      - non-variable-amount intents (no min_take_amount on the intent)
//      - missing claim / fulfilment / fulfilment mid-state-machine
//      - taker_pubkey mismatch
//      - malformed reveal_tx_hex / taker_pubkey
//      - REVEAL_BROADCAST + SETTLED states return idempotently without
//        re-broadcasting.

import workerDefault, {
  decodeAxferVarPayload, T_AXFER_VAR,
  atomicIntentIdHexVar,
} from '../worker/src/index.js';
import { concatBytes } from '@noble/hashes/utils';

let pass = 0, fail = 0;
function test(label, fn) {
  return Promise.resolve()
    .then(fn)
    .then(ok => {
      if (ok === true) { console.log(`  PASS  ${label}`); pass++; }
      else             { console.log(`  FAIL  ${label}`); fail++; }
    })
    .catch(e => {
      console.log(`  THROW ${label}: ${e.message}`); fail++;
    });
}

function makeKvStub() {
  const data = new Map();
  return {
    async get(key, format) {
      const raw = data.get(key);
      if (raw == null) return null;
      return format === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { data.set(key, value); },
    async delete(key) { data.delete(key); },
    async list({ prefix, limit = 1000 } = {}) {
      const keys = [];
      for (const k of data.keys()) if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
      return { keys: keys.slice(0, limit) };
    },
    _data: data,
  };
}

function makeEnv() {
  return {
    REGISTRY_KV: makeKvStub(),
    MAINNET_API: 'https://example.invalid/api',
    SIGNET_API:  'https://example.invalid/api',
  };
}

const ASSET_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const MAKER_PUB = '02' + 'aa'.repeat(32);
const TAKER_PUB = '03' + 'bb'.repeat(32);
const UTXO_TXID = '11'.repeat(32);
const UTXO_VOUT = 0;
const INTENT_ID = atomicIntentIdHexVar(MAKER_PUB, UTXO_TXID, UTXO_VOUT);

function makeVariableIntent(overrides = {}) {
  return {
    asset_id: ASSET_ID,
    intent_id: INTENT_ID,
    maker_pubkey: MAKER_PUB,
    maker_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    amount: '100000000',
    min_take_amount: '10000000',
    price_sats: 50000,
    expiry: Math.floor(Date.now() / 1000) + 3600,
    asset_utxo: { txid: UTXO_TXID, vout: UTXO_VOUT, value: 1000 },
    ticker: 'TAC',
    decimals: 8,
    intent_sig: 'aa'.repeat(64),
    state: 'OPEN',
    created_at: Math.floor(Date.now() / 1000),
    network: 'mainnet',
    ...overrides,
  };
}
function makeClaim(overrides = {}) {
  return {
    intent_id: INTENT_ID,
    taker_pubkey: TAKER_PUB,
    taker_utxo: { txid: '22'.repeat(32), vout: 0, value: 1_000_000 },
    requested_amount: '50000000',
    sig: 'cc'.repeat(64),
    state: 'CLAIMED',
    claimed_at: Math.floor(Date.now() / 1000),
    expires_at: Math.floor(Date.now() / 1000) + 300,
    ...overrides,
  };
}
function makeFulfilment(overrides = {}) {
  return {
    intent_id: INTENT_ID,
    taker_pubkey: TAKER_PUB,
    partial_reveal: { version: 2, inputs: [], outputs: [] },
    fulfilment_sig: 'dd'.repeat(64),
    enc_recipient_blinding: 'ee'.repeat(32),
    requested_amount: '50000000',
    commit_tx_hex: '02000000' + '0'.repeat(40),  // arbitrary placeholder
    envelope_script_hex: 'ab'.repeat(50),
    control_block_hex: 'c0' + 'd0'.repeat(32),
    p2tr_spk_hex: '5120' + 'aa'.repeat(32),
    state: 'COMMIT_READY',
    fulfilled_at: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

async function postFinalize(intent, claim, fulfilment, body, env) {
  const networkPrefix = intent.network === 'mainnet' ? 'mainnet:' : '';
  if (intent) await env.REGISTRY_KV.put(`axintent:${networkPrefix}${intent.asset_id}:${intent.intent_id}`, JSON.stringify(intent));
  if (claim)  await env.REGISTRY_KV.put(`axclaim:${networkPrefix}${intent.asset_id}:${intent.intent_id}`, JSON.stringify(claim));
  if (fulfilment) await env.REGISTRY_KV.put(`axfulfil:${networkPrefix}${intent.asset_id}:${intent.intent_id}`, JSON.stringify(fulfilment));
  const url = `https://w/assets/${intent.asset_id}/atomic-intents/${intent.intent_id}/finalize?network=${intent.network}`;
  const req = new Request(url, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
  const resp = await workerDefault.fetch(req, env);
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, json };
}

// =========== T_AXFER_VAR decoder ===========

console.log('\n=== decodeAxferVarPayload (PR3) ===\n');

function synthesizeAxferVarPayload({ assetInputCount = 1, N = 2, rpLen = 8 } = {}) {
  const parts = [];
  parts.push(new Uint8Array([T_AXFER_VAR]));
  parts.push(new Uint8Array(32).fill(0x11));      // asset_id
  parts.push(new Uint8Array([assetInputCount]));
  parts.push(new Uint8Array(64).fill(0x22));      // kernel_sig
  parts.push(new Uint8Array([N]));
  for (let i = 0; i < N; i++) {
    const commit = new Uint8Array(33); commit[0] = 0x02; commit.fill(0x10 + i, 1);
    parts.push(commit);
    parts.push(new Uint8Array(8).fill(0x33));     // amount_ct
  }
  const rpLenLE = new Uint8Array(2); rpLenLE[0] = rpLen & 0xff; rpLenLE[1] = (rpLen >> 8) & 0xff;
  parts.push(rpLenLE);
  parts.push(new Uint8Array(rpLen).fill(0x44));
  return concatBytes(...parts);
}

await test('decodeAxferVarPayload accepts valid N=2, asset_input_count=1', () => {
  const p = synthesizeAxferVarPayload();
  const d = decodeAxferVarPayload(p);
  return d !== null && d.asset_input_count === 1 && d.n === 2 && d.outputs.length === 2;
});

await test('decodeAxferVarPayload rejects opcode mismatch', () => {
  const p = synthesizeAxferVarPayload();
  p[0] = 0x26; // legacy T_AXFER opcode
  return decodeAxferVarPayload(p) === null;
});

await test('decodeAxferVarPayload rejects asset_input_count != 1', () => {
  return decodeAxferVarPayload(synthesizeAxferVarPayload({ assetInputCount: 2 })) === null
      && decodeAxferVarPayload(synthesizeAxferVarPayload({ assetInputCount: 0 })) === null;
});

await test('decodeAxferVarPayload rejects N != 2', () => {
  return decodeAxferVarPayload(synthesizeAxferVarPayload({ N: 1 })) === null
      && decodeAxferVarPayload(synthesizeAxferVarPayload({ N: 4 })) === null;
});

await test('decodeAxferVarPayload rejects rp_len mismatch', () => {
  const p = synthesizeAxferVarPayload({ rpLen: 8 });
  // Tamper the declared rp_len so it claims 32 bytes but only 8 follow.
  const rpLenOffset = p.length - 8 - 2;
  p[rpLenOffset] = 32; p[rpLenOffset + 1] = 0;
  return decodeAxferVarPayload(p) === null;
});

// =========== /finalize handler ===========

console.log('\n=== /finalize handler dispatch + state machine (PR3) ===\n');

const REVEAL_HEX = '02000000' + '0'.repeat(220);  // ≥ 100 bytes raw, valid hex

await test('finalize rejects legacy intent (no min_take_amount)', async () => {
  const env = makeEnv();
  const legacy = makeVariableIntent({ min_take_amount: undefined });
  const { status, json } = await postFinalize(legacy, makeClaim(), null, { taker_pubkey: TAKER_PUB, reveal_tx_hex: REVEAL_HEX }, env);
  return status === 400 && /only for variable-amount intents/i.test(String(json.error || ''));
});

await test('finalize rejects when no fulfilment record exists', async () => {
  const env = makeEnv();
  const { status, json } = await postFinalize(makeVariableIntent(), makeClaim(), null, { taker_pubkey: TAKER_PUB, reveal_tx_hex: REVEAL_HEX }, env);
  return status === 404 && /no fulfilment record/i.test(String(json.error || ''));
});

await test('finalize rejects when claim is missing', async () => {
  const env = makeEnv();
  const { status, json } = await postFinalize(makeVariableIntent(), null, makeFulfilment(), { taker_pubkey: TAKER_PUB, reveal_tx_hex: REVEAL_HEX }, env);
  return status === 404 && /no active claim/i.test(String(json.error || ''));
});

await test('finalize rejects taker_pubkey mismatch on claim', async () => {
  const env = makeEnv();
  const claim = makeClaim({ taker_pubkey: '02' + 'ff'.repeat(32) });
  const { status, json } = await postFinalize(makeVariableIntent(), claim, makeFulfilment(), { taker_pubkey: TAKER_PUB, reveal_tx_hex: REVEAL_HEX }, env);
  return status === 403 && /taker_pubkey does not match claim/i.test(String(json.error || ''));
});

await test('finalize rejects taker_pubkey mismatch on fulfilment', async () => {
  const env = makeEnv();
  const ful = makeFulfilment({ taker_pubkey: '02' + 'ff'.repeat(32) });
  const { status, json } = await postFinalize(makeVariableIntent(), makeClaim(), ful, { taker_pubkey: TAKER_PUB, reveal_tx_hex: REVEAL_HEX }, env);
  return status === 403 && /fulfilment taker_pubkey does not match claim/i.test(String(json.error || ''));
});

await test('finalize rejects malformed reveal_tx_hex (too short)', async () => {
  const env = makeEnv();
  const { status, json } = await postFinalize(makeVariableIntent(), makeClaim(), makeFulfilment(), { taker_pubkey: TAKER_PUB, reveal_tx_hex: 'aa' }, env);
  return status === 400 && /reveal_tx_hex must be hex/i.test(String(json.error || ''));
});

await test('finalize rejects malformed taker_pubkey', async () => {
  const env = makeEnv();
  const { status, json } = await postFinalize(makeVariableIntent(), makeClaim(), makeFulfilment(), { taker_pubkey: 'nope', reveal_tx_hex: REVEAL_HEX }, env);
  return status === 400 && /taker_pubkey must be 33-byte compressed hex/i.test(String(json.error || ''));
});

await test('finalize rejects fulfilment that is not COMMIT_READY', async () => {
  const env = makeEnv();
  const ful = makeFulfilment({ state: 'OPEN' });
  const { status, json } = await postFinalize(makeVariableIntent(), makeClaim(), ful, { taker_pubkey: TAKER_PUB, reveal_tx_hex: REVEAL_HEX }, env);
  return status === 409 && /cannot transition to REVEAL_READY/i.test(String(json.error || ''));
});

await test('finalize is idempotent on REVEAL_BROADCAST (no re-broadcast attempt)', async () => {
  const env = makeEnv();
  const ful = makeFulfilment({ state: 'REVEAL_BROADCAST', commit_txid: 'aa'.repeat(32), reveal_txid: 'bb'.repeat(32) });
  const { status, json } = await postFinalize(makeVariableIntent(), makeClaim(), ful, { taker_pubkey: TAKER_PUB, reveal_tx_hex: REVEAL_HEX }, env);
  return status === 200 && json.ok === true && /already finalized/i.test(String(json.note || ''));
});

await test('finalize is idempotent on SETTLED', async () => {
  const env = makeEnv();
  const ful = makeFulfilment({ state: 'SETTLED', commit_txid: 'aa'.repeat(32), reveal_txid: 'bb'.repeat(32) });
  const { status, json } = await postFinalize(makeVariableIntent(), makeClaim(), ful, { taker_pubkey: TAKER_PUB, reveal_tx_hex: REVEAL_HEX }, env);
  return status === 200 && json.ok === true;
});

await test('finalize rejects missing commit_tx_hex on fulfilment', async () => {
  const env = makeEnv();
  const ful = makeFulfilment({ commit_tx_hex: '' });
  const { status, json } = await postFinalize(makeVariableIntent(), makeClaim(), ful, { taker_pubkey: TAKER_PUB, reveal_tx_hex: REVEAL_HEX }, env);
  return status === 400 && /missing commit_tx_hex/i.test(String(json.error || ''));
});

console.log(`\n=== ${pass} passed · ${fail} failed ===`);
if (fail > 0) process.exit(1);
