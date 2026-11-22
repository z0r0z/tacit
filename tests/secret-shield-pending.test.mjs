// A shield into the Bitcoin pool counts in the pool with its block. Until then the note it spent is gone from the public list and the pool's list
// holds nothing of it, so secret.js keeps the amount as settling (pendingView) from the moment the shield goes out until the pool lists a note of the
// shield's own transaction. Both ways in are covered, shieldNote and buyAndShield; a shield Bitcoin refused leaves nothing behind.
// What this browser kept is checked against the chain (syncPendingShields): the wallet address's mempool transactions that carry a shield are kept as joining
// (their output notes opened under the pool wallet, so a shield made elsewhere counts, and one into another wallet does not), and a kept shield that is in no block
// and no longer in the mempool is let go. The explorer, the carrier's Bitcoin calls and the prover are stood in; the shield envelope is built for real, and the
// envelope is carried and read back by tacit.js itself.
//   node tests/secret-shield-pending.test.mjs

import assert from 'node:assert/strict';
import { JSDOM } from './_jsdom.mjs';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
for (const k of ['window', 'document', 'location', 'navigator']) globalThis[k] = dom.window[k];
globalThis.__TACIT_NO_INIT__ = true;
dom.window.localStorage.setItem('tacit-network-v1', 'mainnet');
globalThis.localStorage = dom.window.localStorage;
const real = await import('../dapp/tacit.js');

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k), clear: () => mem.clear() };

const secret = await import('../dapp/sats/secret.js');
const { secp } = await import('../dapp/vendor/tacit-deps.min.js');
const { pool, shieldNote, buyAndShield, pendingView, poolWalletFor, TAC_ASSET_MAINNET: ASSET } = secret;

const pw = poolWalletFor(new Uint8Array(32).fill(7), 'mainnet');
const other = poolWalletFor(new Uint8Array(32).fill(8), 'mainnet');
const AMOUNT = 12345n * 10n ** 4n, BLINDING = 987654321n, TXID = 'ab'.repeat(32);
const blindHex = BLINDING.toString(16).padStart(64, '0');
const { cx, cy } = pool.commitXY(AMOUNT, '0x' + blindHex);
const commitment = secp.ProjectivePoint.fromAffine({ x: BigInt(cx), y: BigInt(cy) }).toRawBytes(true);

globalThis.fetch = async (url) => {
  const body = /outspend/.test(url) ? { spent: false } : { vout: [{ value: 546, scriptpubkey: '0014' + '11'.repeat(20) }, { value: 546, scriptpubkey: '0014' + '11'.repeat(20) }] };
  return { ok: true, status: 200, json: async () => body };
};
secret.poolClient.artifactBytes = async () => 0;
secret.poolClient.system = async () => ({});
pool.prove = async () => ({ payload: new Uint8Array(4), payloadHex: '00000000' });

let sent, refuseReveal = false;
const tacit = {
  NET: { api: 'https://esplora.test', api2: null, name: 'mainnet' }, DUST: 546, TAP_NUMS: new Uint8Array(32),
  txOutputEnvelope: () => ({ opcode: 0x01 }), getParentEnvelopeData: async () => ({ assetIdHex: ASSET, commitment }),
  requireValidatedLot: async () => {},
  wallet: { pub: new Uint8Array(33), xonly: () => new Uint8Array(32), address: () => 'bc1qmine' },
  encodeEnvelopeScript: () => new Uint8Array(40), tweakedOutputKey: () => ({ Q_xonly: new Uint8Array(32), parity: 0 }), tapLeafHash: () => new Uint8Array(32),
  p2trScript: () => new Uint8Array(34), controlBlock: () => new Uint8Array(33), p2wpkhScript: () => new Uint8Array(22),
  getFeeRate: async () => 2, feeFor: (vb, rate) => Math.ceil(vb * rate), estCommitVb: () => 150,
  getUtxos: async () => [{ txid: 'cd'.repeat(32), vout: 0, value: 100000 }], selectSatsUtxosSafe: (all) => all, scanHoldings: async () => new Map(),
  signP2wpkhInput: () => [new Uint8Array(64), new Uint8Array(33)], signTaprootScriptPathInput: () => [new Uint8Array(64)],
  txid: (tx) => (tx.inputs[0].txid === 'cd'.repeat(32) ? 'c0'.repeat(32) : 'e1'.repeat(32)),   // the commit spends sats, the reveal spends the commit
  serializeTx: () => new Uint8Array(10), broadcast: async () => {},
  broadcastWithRetry: async () => { if (refuseReveal) throw new Error('bad-txns'); sent = true; },
};
const REVEAL = 'e1'.repeat(32);
const note = { assetId: ASSET, txid: TXID, vout: 0, amount: AMOUNT.toString(), blinding: blindHex };
const sale = {
  asset_outpoint: { txid: TXID, vout: 0, value: 546 }, asset_opening: { amount: AMOUNT.toString(), blinding: blindHex },
  seller_pubkey: '02' + '11'.repeat(32), seller_asset_spend_sig: '00'.repeat(70), seller_payout_script: '0014' + '22'.repeat(20), min_price_sats: 1000,
};
const listed = { asset: '0x' + ASSET, value: String(7n * 10n ** 8n), nf: '0x01', txid: 'a1'.repeat(32), leafIndex: 0 };

// ── shieldNote ──
mem.clear(); sent = false;
assert.deepEqual(pendingView([listed], ASSET, pw), { live: [listed], settling: 0n, leaving: 0n, paying: 0n }, 'nothing is joining before a shield');
const r = await shieldNote(tacit, { note, poolWallet: pw });
assert.ok(sent, 'the shield went out');
assert.equal(r.revealTxid, REVEAL);
let v = pendingView([listed], ASSET, pw);
assert.equal(v.settling, AMOUNT, 'the amount shows as settling');
assert.deepEqual(v.live, [listed], 'the notes already in the pool are untouched');
assert.equal(v.leaving, 0n); assert.equal(v.paying, 0n);
assert.equal(pendingView([listed], ASSET, other).settling, 0n, 'another wallet on this browser does not see it');
assert.equal(pendingView([listed], 'ab'.repeat(32), pw).settling, 0n, 'nor does another asset');
v = pendingView([listed, { ...listed, value: String(AMOUNT), nf: '0x02', txid: REVEAL, leafIndex: 5 }], ASSET, pw);
assert.equal(v.settling, 0n, 'once the pool lists a note of the shield’s transaction it is no longer joining');
assert.equal(v.live.length, 2, 'and the note counts as shielded');

// ── buyAndShield ──
mem.clear(); sent = false;
const b = await buyAndShield(tacit, { status: { asset_id: ASSET }, sale, poolWallet: pw });
assert.ok(sent); assert.equal(b.revealTxid, REVEAL);
assert.equal(pendingView([], ASSET, pw).settling, AMOUNT, 'a lot bought into the pool shows as settling too');

// ── a shield Bitcoin refused ──
mem.clear(); sent = false; refuseReveal = true;
await assert.rejects(() => shieldNote(tacit, { note, poolWallet: pw }), /Bitcoin refused/);
assert.equal(pendingView([], ASSET, pw).settling, 0n, 'nothing is joining when the shield did not go out');

// ── syncPendingShields: the chain's side ──
const hex = (b) => Buffer.from(b).toString('hex');
const shieldPayload = (wallet, amount = AMOUNT) => {
  const { cx: x, cy: y } = pool.commitXY(amount, '0x' + blindHex);
  const built = pool.buildShieldEnvelope({ asset: '0x' + ASSET, inputs: [{ txid: TXID, vout: 0, Cx: x, Cy: y, value: amount, blinding: BLINDING }], recipientAddress: wallet.addressString, network: 'mainnet' });
  return Uint8Array.from([...built.body, ...Buffer.from(built.kernelSig.replace(/^0x/, ''), 'hex'), 4, 0, 0, 0, 0, 0]);
};
const PAYLOAD = { mine: shieldPayload(pw), other: shieldPayload(other, 5n * 10n ** 8n) };   // built once: each is a real proof of the amount's boundary
const carried = (txid, payload) => ({ txid, vin: [{ witness: ['00', hex(real.encodeEnvelopeScript(new Uint8Array(32).fill(5), payload)), '00'] }], vout: [] });
const ADDR = 'bc1qmine', SHIELD_TX = 'f1'.repeat(32), OTHER_TX = 'f2'.repeat(32), PLAIN_TX = 'f3'.repeat(32), OLD_TX = 'f4'.repeat(32);
const chain = { NET: { api: 'https://esplora.test', api2: null }, wallet: { address: () => ADDR }, txOutputEnvelope: real.txOutputEnvelope };
let mempool = [], txs = {}, asked = [];
globalThis.fetch = async (url) => {
  const path = url.replace('https://esplora.test', '');
  asked.push(path);
  if (path === `/address/${ADDR}/txs/mempool`) { if (mempool instanceof Error) throw mempool; return { ok: true, status: 200, json: async () => mempool }; }
  const m = /^\/tx\/([0-9a-f]{64})$/.exec(path);
  const t = m ? txs[m[1]] : undefined;
  if (t instanceof Error) throw t;
  return t === undefined ? { ok: false, status: 404, json: async () => null } : { ok: true, status: 200, json: async () => t };
};
const sync = (wallet = pw) => secret.syncPendingShields(chain, wallet, { force: true });
const keep = (rec) => localStorage.setItem('tacit-pool-pending-v1', JSON.stringify({ spent: {}, change: rec }));
const store = () => JSON.parse(localStorage.getItem('tacit-pool-pending-v1') || '{"change":{}}').change;
const settling = (wallet = pw) => pendingView([], ASSET, wallet).settling;
const aged = (txid, ago, extra = {}) => ({ [txid]: { at: Date.now() - ago, v: String(AMOUNT), asset: ASSET, owner: pw.addressString.slice(-16), shield: true, ...extra } });

// a shield made somewhere else: this browser kept nothing, the mempool holds it
localStorage.clear(); mem.clear();
mempool = [carried(SHIELD_TX, PAYLOAD.mine)];
assert.equal(settling(), 0n, 'nothing kept here');
await sync();
assert.equal(settling(), AMOUNT, 'the shield in the mempool counts as joining, its amount opened under the pool wallet');
assert.equal(store()[SHIELD_TX].shield, true);
await sync();
assert.equal(settling(), AMOUNT, 'a second look does not count it twice');
assert.equal(Object.keys(store()).length, 1);
assert.equal(settling(other), 0n, 'another wallet on this browser does not count it');

// a shield into another wallet, and a transaction that is not a shield, are not this wallet's
localStorage.clear();
mempool = [carried(OTHER_TX, PAYLOAD.other), carried(PLAIN_TX, Uint8Array.from([0x01, 2, 3]))];
await sync();
assert.equal(settling(), 0n, 'a shield into someone else’s pool address is not joining');
assert.deepEqual(store(), {}, 'and nothing is kept for it');

// a kept shield: still in the mempool stays; once the pool lists it nothing is joining (pendingView), and the mempool no longer holds it
localStorage.clear(); keep(aged(SHIELD_TX, 5 * 60e3));
mempool = [carried(SHIELD_TX, PAYLOAD.mine)];
await sync();
assert.equal(settling(), AMOUNT, 'a kept shield still in the mempool stays');
assert.ok(!asked.slice(-3).some((u) => u.includes(`/tx/${SHIELD_TX}`)), 'and is not asked about one by one');

// a kept shield the mempool no longer holds
for (const [what, tx, left] of [
  ['confirmed (in a block)', { status: { confirmed: true } }, AMOUNT],
  ['dropped or replaced (the explorer knows no such transaction)', undefined, 0n],
  ['unknown because the explorer did not answer', new Error('offline'), AMOUNT],
]) {
  localStorage.clear(); keep(aged(OLD_TX, 5 * 60e3)); mempool = []; txs = { [OLD_TX]: tx };
  await sync();
  assert.equal(settling(), left, `a kept shield that is ${what}: ${left === 0n ? 'let go' : 'kept'}`);
}
localStorage.clear(); keep(aged(OLD_TX, 20e3)); mempool = []; txs = {};
await sync();
assert.equal(settling(), AMOUNT, 'a shield sent seconds ago is kept even if the explorer has not heard of it yet');
localStorage.clear(); keep(aged(OLD_TX, 5 * 60e3, { owner: other.addressString.slice(-16) })); mempool = []; txs = {};
await sync();
assert.equal(settling(other), AMOUNT, 'another wallet’s kept shield is not judged by this wallet’s look');
localStorage.clear(); keep({ [OLD_TX]: { at: Date.now() - 5 * 60e3, v: String(AMOUNT), asset: ASSET, owner: pw.addressString.slice(-16) } }); mempool = []; txs = {};
await sync();
assert.equal(settling(), AMOUNT, 'a record that is not a shield (a relayed payment’s change) is left to the pool’s list');

// the look is shared and spaced, and an explorer that does not answer changes nothing
localStorage.clear(); mem.clear(); keep(aged(SHIELD_TX, 5 * 60e3)); mempool = [carried(SHIELD_TX, PAYLOAD.mine)]; asked = [];
const first = secret.syncPendingShields(chain, pw, { force: true });
assert.equal(secret.syncPendingShields(chain, pw), first, 'a look within 15 seconds is the one already made');
await first;
assert.equal(asked.filter((u) => u.endsWith('/txs/mempool')).length, 1, 'one request for the mempool');
mempool = new Error('offline');
await assert.rejects(() => sync(), /offline/);
assert.equal(settling(), AMOUNT, 'an explorer that does not answer leaves what was kept');
mempool = [carried(SHIELD_TX, PAYLOAD.mine)];
await secret.syncPendingShields(chain, pw);
assert.equal(settling(), AMOUNT, 'and the next look is made again, not held to the failed one');

console.log('secret shield pending: all passed');
process.exit(0);   // tacit.js, loaded for its envelope reader, keeps timers alive
