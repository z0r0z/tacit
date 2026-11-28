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
assert.deepEqual(pendingView([listed], ASSET, pw), { live: [listed], settling: 0n, leaving: 0n, paying: 0n, shields: [], refused: [] }, 'nothing is joining before a shield');
const r = await shieldNote(tacit, { note, poolWallet: pw });
assert.ok(sent, 'the shield went out');
assert.equal(r.revealTxid, REVEAL);
let v = pendingView([listed], ASSET, pw);
assert.equal(v.settling, AMOUNT, 'the amount shows as settling');
assert.deepEqual(v.live, [listed], 'the notes already in the pool are untouched');
assert.equal(v.leaving, 0n); assert.equal(v.paying, 0n);
assert.equal(v.shields.length, 1, 'the shield is listed as one waiting');
assert.equal(v.shields[0].txid, REVEAL); assert.equal(v.shields[0].st, null, 'with no place yet: nothing has looked at the chain');
assert.equal(secret.shieldLine(v.shields), 'counts after 3 Bitcoin confirmations', 'and the line says what is known: the pool counts a block at three confirmations');
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

// ── shieldFromSaleKey (TAC at a sale key put back in the pool) ──
{
  mem.clear(); sent = false; refuseReveal = false;
  const SALE_SPK = Buffer.from('0014' + '11'.repeat(20), 'hex');   // the explorer's stand-in output script above
  const saleTacit = { ...tacit, p2wpkhScript: () => SALE_SPK, signP2wpkhInputWithKey: () => [new Uint8Array(64), new Uint8Array(33)] };
  const saleKey = { pub: '02' + '33'.repeat(32), priv: '44'.repeat(32) }, saleNote = { txid: TXID, vout: 0, value: AMOUNT.toString(), blinding: '0x' + blindHex };
  const sk = await secret.shieldFromSaleKey(saleTacit, { key: saleKey, note: saleNote, asset: ASSET, poolWallet: pw });
  assert.ok(sent, 'the put-back went out'); assert.equal(sk.revealTxid, REVEAL);
  assert.equal(pendingView([], ASSET, pw).settling, AMOUNT, 'TAC put back in the pool from a sale key shows as joining too: it is at no sale key now and not in the pool’s list yet');
}

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
const chain2 = { ...chain, NET: { api: 'https://esplora.test', api2: 'https://esplora2.test' } };   // two explorers, as the page has
let mempool = [], txs = {}, txs2 = {}, asked = [], tipHeight = null, poolStatus = null, poolFeed = [], poolEnvelope, envelopeAsked = 0;   // (poolEnvelope undefined: a replay without the route, which answers 404)
const POOL = 'https://tacit-btc-pool-mainnet.onrender.com/btc-pool/';
const reply = (t) => (t instanceof Error ? Promise.reject(t) : t === undefined || t === null ? { ok: false, status: 404, json: async () => null } : { ok: true, status: 200, json: async () => t });
globalThis.fetch = async (url) => {
  url = String(url);
  if (url.startsWith(POOL + 'status')) return poolStatus instanceof Error ? Promise.reject(poolStatus) : poolStatus ? reply(poolStatus) : { ok: false, status: 503, json: async () => null };
  if (url.startsWith(POOL + 'envelope/')) { envelopeAsked++; return poolEnvelope instanceof Error ? Promise.reject(poolEnvelope) : poolEnvelope === undefined ? { ok: false, status: 404, json: async () => ({ error: 'not found' }) } : reply(poolEnvelope); }
  if (url.startsWith(POOL + 'notes')) {
    if (poolFeed instanceof Error) return Promise.reject(poolFeed);
    const from = Number(/from=(\d+)/.exec(url)[1]), rows = poolFeed.filter((n) => n.leafIndex >= from);
    return reply({ height: 0, from, notes: rows, next: rows.length ? rows[rows.length - 1].leafIndex + 1 : from });
  }
  const second = url.startsWith('https://esplora2.test'), path = url.replace('https://esplora2.test', '').replace('https://esplora.test', '');
  if (!second) asked.push(path);
  if (path === `/address/${ADDR}/txs/mempool`) { if (mempool instanceof Error) throw mempool; return reply(mempool); }
  if (path === '/blocks/tip/height') return reply(second ? undefined : tipHeight);
  const m = /^\/tx\/([0-9a-f]{64})$/.exec(path);
  return reply(m ? (second ? txs2 : txs)[m[1]] : undefined);
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

// where a kept shield is on its way to the pool's list (what the look finds out, and says): in the mempool, in a block with n of 3 confirmations, in a block the pool has not
// read yet, the pool paused, in the list, or in a block the pool has read and not taken
const H = 977000, feedRow = (i, txid) => ({ leafIndex: i, txid, height: H, leaf: '0x' + String(i).padStart(64, '0'), asset: '0x' + ASSET, pk_eph: '02' + '00'.repeat(32), ct_note: '00'.repeat(24) });
const inBlock = (h = H) => ({ status: { confirmed: true, block_height: h } });
const stageOf = async (tx, { tip = null, rs = null, feed = [], ago = 5 * 60e3, extra = {}, via = chain, txid = OLD_TX, verdict = undefined } = {}) => {
  localStorage.clear(); mem.clear(); keep(aged(txid, ago, extra)); mempool = []; txs = { [txid]: tx }; txs2 = {}; tipHeight = tip; poolStatus = rs; poolFeed = feed; poolEnvelope = verdict; envelopeAsked = 0;
  await secret.syncPendingShields(via, pw, { force: true });
  return store()[txid];
};
const REF_TX = 'f6'.repeat(32);   // (the pool client holds the list it read for 20 s, so each scenario that depends on the list has a transaction of its own)
const RS = (height, extra = {}) => ({ height, confirmations: 3, halted: null, ...extra });
let c = await stageOf({ status: { confirmed: false } });
assert.equal(c.st, 'mempool', 'a kept shield the address list missed but the explorer holds unconfirmed is in the mempool');
c = await stageOf(inBlock(), { tip: H, rs: RS(H - 2) });
assert.deepEqual([c.st, c.h, c.conf, c.need], ['confirming', H, 1, 3], 'in its block: 1 of 3 confirmations');
assert.equal(secret.shieldLine(pendingView([], ASSET, pw).shields), 'confirmed in Bitcoin, 1 of 3 confirmations');
c = await stageOf(inBlock(), { tip: H + 1, rs: RS(H - 1) });
assert.deepEqual([c.st, c.conf], ['confirming', 2]);
c = await stageOf(inBlock(), { tip: H + 2, rs: RS(H - 1) });
assert.equal(c.st, 'behind', 'three confirmations and the pool has not read the block yet');
assert.equal(secret.shieldLine(pendingView([], ASSET, pw).shields), 'confirmed in Bitcoin, the pool is catching up to it');
c = await stageOf(inBlock(), { tip: H + 2, rs: RS(H - 1, { halted: { height: H - 1 } }) });
assert.equal(c.st, 'paused', 'the pool paused: it takes the shield when it is back');
c = await stageOf(inBlock(), { tip: H + 2, rs: RS(H), feed: [feedRow(0, OLD_TX)] });
assert.equal(c.st, 'reading', 'the pool has read the block and holds notes of the shield');
assert.equal(settling(), AMOUNT, 'and it still counts as joining until the page has opened them');
c = await stageOf(inBlock(), { tip: H + 2, rs: RS(H), feed: [feedRow(0, 'f9'.repeat(32))], txid: REF_TX });
assert.equal(c.st, 'refused', 'the pool has read the block and holds nothing of this shield');
let pv = pendingView([], ASSET, pw);
assert.equal(pv.settling, 0n, 'a refused shield is not counted as on its way');
assert.deepEqual(pv.refused.map((x) => [x.txid, x.v, x.h]), [[REF_TX, AMOUNT, H]], 'it is listed as refused, with its block');
assert.deepEqual(pv.shields, []);
assert.equal(pendingView([{ asset: '0x' + ASSET, value: String(AMOUNT), txid: REF_TX, nf: '0x09' }], ASSET, pw).refused.length, 0, 'and goes if the pool lists a note of it after all');
asked = []; await secret.syncPendingShields(chain, pw, { force: true });
assert.ok(!asked.some((u) => u.includes(`/tx/${REF_TX}`)), 'a refused shield is not asked about again');
// why it was refused: the replay's own verdict on the shield's envelope, said in plain words; a replay without the route leaves only that the list holds nothing of it
const REASON = `input ${'ee'.repeat(32)}:0 is not a valid note of the asset`, SH_OP = 0x6c;
const verdictOf = (...envelopes) => ({ seen: envelopes.length > 0, height: H + 2, envelopes: envelopes.map((e) => ({ height: H, vin: 0, opcode: SH_OP, accepted: false, reason: null, ...e })) });
const notListed = { rs: RS(H), tip: H + 2, feed: [feedRow(0, 'f9'.repeat(32))] };
c = await stageOf(inBlock(), { ...notListed, txid: 'fa'.repeat(32), verdict: verdictOf({ reason: REASON }) });
assert.deepEqual([c.st, c.reason], ['refused', REASON], 'refused with the reason the replay gave');
pv = pendingView([], ASSET, pw);
assert.match(pv.refused[0].why, /^The pool did not accept the TAC note it spent as a valid note of this asset/, 'said in plain words');
assert.equal(pv.refused[0].reason, REASON, 'and the raw reason is kept for the person who looks into it');
c = await stageOf(inBlock(), { ...notListed, txid: 'fb'.repeat(32), verdict: verdictOf() });
assert.equal(c.none, true, 'a transaction in which the replay found no pool envelope');
assert.equal(pendingView([], ASSET, pw).refused[0].why, 'The pool found no shield in that transaction.');
c = await stageOf(inBlock(), { ...notListed, txid: 'fc'.repeat(32), verdict: verdictOf({ accepted: true }) });
assert.equal(c.st, 'reading', 'the replay says it took the shield although the list this page holds does not show it yet: not refused');
assert.deepEqual(pendingView([], ASSET, pw).refused, []);
for (const [what, verdict] of [['a replay without the route (404)', undefined], ['a verdict that cannot be read', new Error('offline')]]) {
  c = await stageOf(inBlock(), { ...notListed, txid: 'fd'.repeat(32), verdict });
  assert.deepEqual([c.st, c.reason, c.none], ['refused', undefined, undefined], `${what}: refused as before, with no reason`);
  assert.equal(pendingView([], ASSET, pw).refused[0].why, '', 'and nothing more said');
}
// a refusal kept before the replay could say why is asked again, at most every ten minutes, and the reason is added; one the replay says it took goes back to waiting
localStorage.clear(); mem.clear(); keep(aged('fe'.repeat(32), 3600e3, { st: 'refused', h: H })); mempool = []; txs = {}; poolEnvelope = verdictOf({ reason: REASON }); envelopeAsked = 0;
await secret.syncPendingShields(chain, pw, { force: true });
assert.equal(store()['fe'.repeat(32)].reason, REASON); assert.equal(envelopeAsked, 1);
await secret.syncPendingShields(chain, pw, { force: true });
assert.equal(envelopeAsked, 1, 'a refusal that has its reason is not asked about again');
localStorage.clear(); mem.clear(); keep(aged('ff'.repeat(32), 3600e3, { st: 'refused', h: H })); poolEnvelope = undefined; envelopeAsked = 0;
await secret.syncPendingShields(chain, pw, { force: true }); await secret.syncPendingShields(chain, pw, { force: true });
assert.equal(envelopeAsked, 1, 'one that the replay cannot answer is asked again only after ten minutes');
localStorage.clear(); mem.clear(); keep(aged('ff'.repeat(32), 3600e3, { st: 'refused', h: H })); poolEnvelope = verdictOf({ accepted: true });
await secret.syncPendingShields(chain, pw, { force: true });
assert.equal(store()['ff'.repeat(32)].st, 'reading', 'a refusal the replay now says it did not make is waiting again');
for (const [r, re] of [[REASON, /valid note of this asset/], ['T_BTC_SHIELD must ride vin[0]', /first input/], ['non-canonical envelope', /form the pool reads/], ['carrier has too few inputs', /did not spend the note/], ['proof does not verify', /proof did not verify/], ['kernel signature does not verify', /proof did not verify/], ['note tree is full', /tree is full/]]) assert.match(secret.shieldWhy({ reason: r }), re, r);
assert.equal(secret.shieldWhy({ reason: 'something new at the replay' }), 'The pool’s reason: something new at the replay.', 'a reason it does not know is shown as given');
assert.equal(secret.shieldWhy({}), ''); assert.equal(secret.shieldWhy({ reason: '' }), '');

c = await stageOf(inBlock(), { tip: H + 2, rs: RS(H) , feed: new Error('offline') });
assert.equal(c.st, 'reading', 'a list that cannot be read says nothing against the shield');
c = await stageOf(inBlock(), { tip: H + 5, rs: new Error('offline') });
assert.equal(c.st, 'behind', 'a pool status that cannot be read says nothing against it either');
c = await stageOf(inBlock(), { tip: null, rs: RS(H - 2) });
assert.deepEqual([c.st, c.conf], ['confirming', null], 'without the chain tip it is in a block, number of confirmations not known');
assert.equal(secret.shieldLine(pendingView([], ASSET, pw).shields), 'confirmed in Bitcoin, counts after 3 confirmations');
c = await stageOf({ status: { confirmed: true } }, { tip: H, rs: RS(H) });
assert.equal(c.st, 'confirming', 'a block height the explorer does not give is not guessed at');

// how long a record is kept: a shield for days (Bitcoin can take that long), one the pool refused for a month, the change of a payment for six hours
const view = (rec) => { localStorage.clear(); mem.clear(); keep(rec); return pendingView([], ASSET, pw); };
assert.equal(view(aged(OLD_TX, 11 * 3600e3)).settling, AMOUNT, 'a shield waiting eleven hours is still there (it was let go at six)');
assert.equal(view(aged(OLD_TX, 2 * 86400e3)).settling, AMOUNT, 'and after two days');
assert.equal(view(aged(OLD_TX, 4 * 86400e3)).settling, 0n, 'but not after four');
assert.equal(view(aged(OLD_TX, 10 * 86400e3, { st: 'refused', h: H })).refused.length, 1, 'a refused shield is still said after ten days');
assert.equal(view(aged(OLD_TX, 31 * 86400e3, { st: 'refused', h: H })).refused.length, 0, 'not after a month');
assert.equal(view({ [OLD_TX]: { at: Date.now() - 7 * 3600e3, v: String(AMOUNT), asset: ASSET, owner: pw.addressString.slice(-16) } }).settling, 0n, 'the change of a payment is let go at six hours, as before');
assert.equal(view({ [OLD_TX]: { ...aged(OLD_TX, 60e3)[OLD_TX], st: 'refused' }, [SHIELD_TX]: aged(SHIELD_TX, 60e3)[SHIELD_TX] }).settling, AMOUNT, 'a refused shield is not added to what is joining');

// a transaction one explorer has dropped or never heard of and another holds is not gone
localStorage.clear(); mem.clear(); keep(aged(OLD_TX, 5 * 60e3)); mempool = []; txs = {}; txs2 = { [OLD_TX]: { status: { confirmed: false } } }; tipHeight = null; poolStatus = null; poolFeed = [];
await secret.syncPendingShields(chain2, pw, { force: true });
assert.equal(store()[OLD_TX]?.st, 'mempool', 'the first explorer says 404, the second holds it: it is in the mempool');
for (const [what, first, second, kept] of [
  ['both explorers have no such transaction', undefined, undefined, false],
  ['the second does not answer', undefined, new Error('429'), true],
  ['the first does not answer', new Error('429'), undefined, true],
]) {
  localStorage.clear(); mem.clear(); keep(aged(OLD_TX, 5 * 60e3)); txs = { [OLD_TX]: first }; txs2 = { [OLD_TX]: second };
  await secret.syncPendingShields(chain2, pw, { force: true });
  assert.equal(OLD_TX in store(), kept, `${what}: ${kept ? 'kept' : 'let go'}`);
}
txs2 = {};

// what the line says of the shield furthest from the pool
const now = Date.now(), line = (...sh) => secret.shieldLine(sh.map((x) => ({ need: 3, at: now, ...x })), now);
assert.equal(line(), '');
assert.equal(line({ st: 'mempool', at: now - 10 * 60e3 }), 'waiting for Bitcoin to confirm it');
assert.match(line({ st: 'mempool', at: now - 5 * 3600e3 }), /^still unconfirmed in Bitcoin after 5 h, usually a low fee \(it confirms or drops out, and the TAC comes back if it drops\)$/);
assert.match(line({ st: 'mempool', at: now - 100 * 60e3 }), /^waiting for Bitcoin to confirm it$/, 'under two hours is not yet a long wait');
assert.equal(line({ st: 'confirming', conf: 2 }), 'confirmed in Bitcoin, 2 of 3 confirmations');
assert.equal(line({ st: 'paused' }), 'confirmed in Bitcoin, the pool is paused and takes it when it is back');
assert.equal(line({ st: 'reading' }), 'in the pool, being read');
assert.equal(line({ st: 'reading' }, { st: 'mempool' }), 'waiting for Bitcoin to confirm it', 'of several, the one furthest from the pool');
assert.equal(line({ st: 'confirming', conf: 1 }, { st: null }), 'counts after 3 Bitcoin confirmations', 'one whose place is not known yet is said as that');

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

// the proving line promises 15 seconds only while that is likely
assert.match(secret.proveLine(0), /^Proving on your device \(~15 s\)… 0 s$/);
assert.match(secret.proveLine(30), /~15 s/);
assert.doesNotMatch(secret.proveLine(31), /~15 s/);
assert.match(secret.proveLine(212), /^Proving on your device… 212 s\. A busy device can take a few minutes; keep this tab open\.$/);

console.log('secret shield pending: all passed');
process.exit(0);   // tacit.js, loaded for its envelope reader, keeps timers alive
