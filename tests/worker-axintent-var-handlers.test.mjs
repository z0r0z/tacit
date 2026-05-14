// PR2: variable-amount atomic-intent handler dispatch + validation tests.
//
// Exercises the negative paths that fail BEFORE the on-chain fetch — so no
// mempool.space stubbing is needed. The happy path is covered by the signet
// e2e harness in PR3 (which drives the full handler against real fetch +
// real KV).
//
// What this pins down:
//   1. Dispatch: legacy body (no min_take_amount) does NOT route to the
//      variable-amount helper (verified by error-text contract).
//   2. Variable-amount publish bounds: min_take ≥ 1, min_take ≤ amount,
//      min_take != amount (degenerate; legacy path should be used).
//   3. intent_id derivation: a body with the wrong intent_id is rejected
//      against the v1 deterministic formula.
//   4. Variable-amount claim: requested_amount field required + bounds-
//      checked against intent.min_take_amount and intent.amount.
//   5. Variable-amount fulfilment: extended payload shape enforced
//      (commit_tx_hex / envelope_script_hex / control_block_hex / p2tr_spk_hex).
//
// What this does NOT cover (intentionally — PR3's signet e2e does):
//   - The full asset_utxo on-chain verification path.
//   - intent_sig / claim_sig / fulfilment_sig verification under valid msgs
//     (covered by PR1's pure-function tests).
//   - State transitions across multiple POSTs.

import workerDefault, {
  atomicIntentIdHexVar,
} from '../worker/src/index.js';

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

// Minimal KV stub. The variable-amount publish handler doesn't read from
// REGISTRY_KV before its bound checks fire, so this stub never has to return
// anything for the tests below. We still implement get/put/list/delete so
// any post-bound-check write paths don't blow up.
function makeKvStub() {
  const data = new Map();
  return {
    async get(key, format) {
      const raw = data.get(key);
      if (raw == null) return null;
      return format === 'json' ? JSON.parse(raw) : raw;
    },
    async put(key, value) { data.set(key, value); },
    async delete(key)     { data.delete(key); },
    async list({ prefix, limit = 1000 } = {}) {
      const keys = [];
      for (const k of data.keys()) if (!prefix || k.startsWith(prefix)) keys.push({ name: k });
      return { keys: keys.slice(0, limit) };
    },
    _data: data,
  };
}

function makeEnv(extra = {}) {
  return {
    REGISTRY_KV: makeKvStub(),
    MAINNET_API: 'https://example.invalid/api',
    SIGNET_API:  'https://example.invalid/api',
    ...extra,
  };
}

function makeReq(body) {
  return new Request('https://w/atomic-intents', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const ASSET_ID = 'f0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const MAKER_PUB = '02' + 'aa'.repeat(32);
const TAKER_PUB = '03' + 'bb'.repeat(32);
const UTXO_TXID = '11'.repeat(32);
const UTXO_VOUT = 0;
const NETWORK_QS = 'mainnet';

// Build a fake fetch handler-style POST against the worker's default export
// so we test the route → handleAtomicIntentPost → dispatch path end-to-end
// for everything that doesn't touch the chain.
async function postIntent(body, env = makeEnv()) {
  const url = `https://w/assets/${ASSET_ID}/atomic-intents?network=${NETWORK_QS}`;
  const req = new Request(url, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
  const resp = await workerDefault.fetch(req, env);
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, json };
}

async function postClaim(intent, claimBody, env) {
  // Pre-seed the intent record so the claim handler can load it.
  await env.REGISTRY_KV.put(
    `axintent:${intent.network === 'mainnet' ? 'mainnet:' : ''}${intent.asset_id}:${intent.intent_id}`,
    JSON.stringify(intent),
  );
  const url = `https://w/assets/${intent.asset_id}/atomic-intents/${intent.intent_id}/claim?network=${intent.network}`;
  const req = new Request(url, {
    method: 'POST',
    body: JSON.stringify(claimBody),
    headers: { 'content-type': 'application/json' },
  });
  const resp = await workerDefault.fetch(req, env);
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, json };
}

async function postFulfil(intent, claim, fulfilBody, env) {
  await env.REGISTRY_KV.put(
    `axintent:${intent.network === 'mainnet' ? 'mainnet:' : ''}${intent.asset_id}:${intent.intent_id}`,
    JSON.stringify(intent),
  );
  await env.REGISTRY_KV.put(
    `axclaim:${intent.network === 'mainnet' ? 'mainnet:' : ''}${intent.asset_id}:${intent.intent_id}`,
    JSON.stringify(claim),
  );
  const url = `https://w/assets/${intent.asset_id}/atomic-intents/${intent.intent_id}/fulfilment?network=${intent.network}`;
  const req = new Request(url, {
    method: 'POST',
    body: JSON.stringify(fulfilBody),
    headers: { 'content-type': 'application/json' },
  });
  const resp = await workerDefault.fetch(req, env);
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, json };
}

console.log('\n=== T_AXFER_VAR handler dispatch + validation (PR2) ===\n');

// --- DISPATCH: legacy body falls through to v1 handler ---

await test('legacy body (no min_take_amount) routes to v1 handler', async () => {
  // V1 expects commit_txid + envelope_script_hex; bare body fails v1's first
  // mandatory check. If dispatch leaked the request to _Var instead, the error
  // text would mention min_take_amount or intent_sig.
  const { status, json } = await postIntent({ asset_utxo: { txid: UTXO_TXID, vout: 0 } });
  if (status !== 400) return false;
  // The legacy handler's earliest field check is intent_id format. If we hit
  // it, dispatch was correctly to the v1 path.
  return /intent_id|maker_pubkey/i.test(String(json.error || ''));
});

// --- PUBLISH: variable-amount bound checks ---

const intentIdGood = atomicIntentIdHexVar(MAKER_PUB, UTXO_TXID, UTXO_VOUT);

function publishBody(overrides = {}) {
  const futureExpiry = Math.floor(Date.now() / 1000) + 3600;
  return {
    intent_id: intentIdGood,
    maker_pubkey: MAKER_PUB,
    maker_address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
    amount: '100000000',
    min_take_amount: '10000000',
    price_sats: 50000,
    expiry: futureExpiry,
    asset_utxo: { txid: UTXO_TXID, vout: UTXO_VOUT, value: 1000 },
    ticker: 'TAC',
    decimals: 8,
    intent_sig: 'aa'.repeat(64),
    ...overrides,
  };
}

await test('publish_var rejects min_take_amount == "" (presence required)', async () => {
  const { status, json } = await postIntent(publishBody({ min_take_amount: '' }));
  // Empty min_take_amount → dispatch sees falsy and falls through to legacy
  // path, which then complains about missing intent_id (since the body shape
  // doesn't match v1 either). Confirms the discriminator check.
  return status === 400 && /intent_id|maker_pubkey|commit_txid/i.test(String(json.error || ''));
});

await test('publish_var rejects min_take_amount > amount', async () => {
  const { status, json } = await postIntent(publishBody({ amount: '1000', min_take_amount: '2000' }));
  return status === 400 && /min_take_amount must not exceed amount/i.test(String(json.error || ''));
});

await test('publish_var rejects min_take_amount == amount (degenerate)', async () => {
  const { status, json } = await postIntent(publishBody({ amount: '1000', min_take_amount: '1000' }));
  return status === 400 && /degenerate|whole-UTXO|use the legacy path/i.test(String(json.error || ''));
});

await test('publish_var rejects min_take_amount < 1', async () => {
  const { status, json } = await postIntent(publishBody({ min_take_amount: '0' }));
  return status === 400 && /min_take_amount must be ≥ 1/i.test(String(json.error || ''));
});

await test('publish_var rejects non-numeric min_take_amount', async () => {
  const { status, json } = await postIntent(publishBody({ min_take_amount: 'abc' }));
  return status === 400 && /min_take_amount must be base-10 integer string/i.test(String(json.error || ''));
});

await test('publish_var rejects mis-derived intent_id', async () => {
  const wrongIntentId = '00'.repeat(16);
  const { status, json } = await postIntent(publishBody({ intent_id: wrongIntentId }));
  return status === 400 && /intent_id does not derive/i.test(String(json.error || ''));
});

await test('publish_var rejects invalid maker_pubkey', async () => {
  const { status, json } = await postIntent(publishBody({ maker_pubkey: 'nope' }));
  return status === 400 && /maker_pubkey/i.test(String(json.error || ''));
});

await test('publish_var rejects expiry in the past', async () => {
  const { status, json } = await postIntent(publishBody({ expiry: Math.floor(Date.now() / 1000) - 60 }));
  return status === 400 && /expiry must be in the future/i.test(String(json.error || ''));
});

await test('publish_var rejects malformed intent_sig', async () => {
  const { status, json } = await postIntent(publishBody({ intent_sig: 'short' }));
  return status === 400 && /intent_sig must be 128 hex chars/i.test(String(json.error || ''));
});

// --- CLAIM: variable-amount requested_amount bound checks ---

function makeVariableIntent(overrides = {}) {
  return {
    asset_id: ASSET_ID,
    intent_id: intentIdGood,
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

function claimBody(overrides = {}) {
  return {
    taker_pubkey: TAKER_PUB,
    sig: 'cc'.repeat(64),
    taker_utxo: { txid: '22'.repeat(32), vout: 0 },
    requested_amount: '50000000',
    ...overrides,
  };
}

await test('claim_var rejects missing requested_amount', async () => {
  const env = makeEnv();
  const { status, json } = await postClaim(makeVariableIntent(), claimBody({ requested_amount: undefined }), env);
  return status === 400 && /requested_amount/i.test(String(json.error || ''));
});

await test('claim_var rejects non-numeric requested_amount', async () => {
  const env = makeEnv();
  const { status, json } = await postClaim(makeVariableIntent(), claimBody({ requested_amount: 'oops' }), env);
  return status === 400 && /requested_amount must be base-10 integer string/i.test(String(json.error || ''));
});

await test('claim_var rejects requested below min_take', async () => {
  const env = makeEnv();
  const intent = makeVariableIntent({ min_take_amount: '20000000', amount: '100000000' });
  const { status, json } = await postClaim(intent, claimBody({ requested_amount: '5000000' }), env);
  return status === 400 && /below min_take_amount/i.test(String(json.error || ''));
});

await test('claim_var rejects requested above amount', async () => {
  const env = makeEnv();
  const intent = makeVariableIntent({ min_take_amount: '10000000', amount: '100000000' });
  const { status, json } = await postClaim(intent, claimBody({ requested_amount: '500000000' }), env);
  return status === 400 && /exceeds listed amount/i.test(String(json.error || ''));
});

// --- FULFIL: variable-amount payload shape checks ---

function fulfilBody(overrides = {}) {
  return {
    taker_pubkey: TAKER_PUB,
    partial_reveal: { version: 2, inputs: [], outputs: [] },
    fulfilment_sig: 'dd'.repeat(64),
    enc_recipient_blinding: 'ee'.repeat(32),
    commit_tx_hex: '00'.repeat(40),
    envelope_script_hex: 'ab'.repeat(50),
    control_block_hex: 'c0' + 'd0'.repeat(32),
    p2tr_spk_hex: '5120' + 'aa'.repeat(32),
    ...overrides,
  };
}

function liveClaim(overrides = {}) {
  return {
    intent_id: intentIdGood,
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

await test('fulfil_var rejects missing commit_tx_hex', async () => {
  const env = makeEnv();
  const { status, json } = await postFulfil(makeVariableIntent(), liveClaim(), fulfilBody({ commit_tx_hex: '' }), env);
  return status === 400 && /commit_tx_hex must be hex/i.test(String(json.error || ''));
});

await test('fulfil_var rejects missing envelope_script_hex', async () => {
  const env = makeEnv();
  const { status, json } = await postFulfil(makeVariableIntent(), liveClaim(), fulfilBody({ envelope_script_hex: '' }), env);
  return status === 400 && /envelope_script_hex required/i.test(String(json.error || ''));
});

await test('fulfil_var rejects malformed p2tr_spk_hex (wrong prefix)', async () => {
  const env = makeEnv();
  const { status, json } = await postFulfil(makeVariableIntent(), liveClaim(), fulfilBody({ p2tr_spk_hex: '0014' + 'aa'.repeat(20) }), env);
  return status === 400 && /p2tr_spk_hex/i.test(String(json.error || ''));
});

await test('fulfil_var rejects malformed control_block_hex', async () => {
  const env = makeEnv();
  const { status, json } = await postFulfil(makeVariableIntent(), liveClaim(), fulfilBody({ control_block_hex: 'short' }), env);
  return status === 400 && /control_block_hex must be 33-byte hex/i.test(String(json.error || ''));
});

await test('fulfil_var rejects bad fulfilment_sig hex shape', async () => {
  const env = makeEnv();
  const { status, json } = await postFulfil(makeVariableIntent(), liveClaim(), fulfilBody({ fulfilment_sig: 'tooshort' }), env);
  return status === 400 && /fulfilment_sig must be 128 hex chars/i.test(String(json.error || ''));
});

await test('fulfil_var rejects when claim lacks requested_amount', async () => {
  const env = makeEnv();
  const claim = liveClaim({ requested_amount: undefined });
  const { status, json } = await postFulfil(makeVariableIntent(), claim, fulfilBody(), env);
  return status === 400 && /claim is missing requested_amount/i.test(String(json.error || ''));
});

console.log(`\n=== ${pass} passed · ${fail} failed ===`);
if (fail > 0) process.exit(1);
