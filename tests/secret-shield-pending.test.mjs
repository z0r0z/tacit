// A shield into the Bitcoin pool counts in the pool with its block. Until then the note it spent is gone from the public list and the pool's list
// holds nothing of it, so secret.js keeps the amount as settling (pendingView) from the moment the shield goes out until the pool lists a note of the
// shield's own transaction. Both ways in are covered, shieldNote and buyAndShield; a shield Bitcoin refused leaves nothing behind.
// The explorer, the carrier's Bitcoin calls and the prover are stood in; the shield envelope is built for real.
//   node tests/secret-shield-pending.test.mjs

import assert from 'node:assert/strict';

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };

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

console.log('secret shield pending: all passed');
