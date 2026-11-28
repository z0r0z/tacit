// worker-relay/src/bridge-recover.js: the recovery service sends each claim once, from untracked notes first,
// resolves a send cut short from whether its notes were spent, and holds a claim that no longer checks out.
import { test } from 'node:test';
import assert from 'node:assert';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { sha256 } from '../node_modules/@noble/hashes/sha2.js';
import { ripemd160 } from '../node_modules/@noble/hashes/legacy.js';
import * as secp from '../node_modules/@noble/secp256k1/index.js';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { signSchnorr, verifySchnorr } from '../dapp/bulletproofs.js';
import { makeBridgeRecover } from '../dapp/bridge-recover.js';
import { makeRecoverer, makeTopUp } from '../worker-relay/src/bridge-recover.js';
import * as vdeps from '../dapp/vendor/tacit-deps.min.js';

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(sha256, key, _cat(m));
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const hex = (b) => Buffer.from(b).toString('hex');
const WALLET = new Uint8Array(32).fill(0x31);
const AMOUNT = 10000000000n, BLINDING = 0x1234567890abcdefn;
const BURN = 'b1'.repeat(32), HOME = 'c2'.repeat(32), FUND = 'd3'.repeat(32), PAID = 'e4'.repeat(32), ELSE = 'f5'.repeat(32);
const opKey = (txid, vout) => String(pool.outpointKey('0x' + txid.match(/../g).reverse().join(''), vout)).toLowerCase();

function world({ status = 'queued', inputs, sendingAt = 0, notes, live = new Set(), dests = new Set(), before: ahead = [], refuseSending = false, sendFails = false, stateHeight = 1000, nowMs = 1_000_000 } = {}) {
  const verifier = makeBridgeRecover({ secp, sha256, ripemd160, pool, classifyConfidentialTx: (h) => kinds[h.replace(/^0x/, '')] || null, signSchnorr, verifySchnorr, tacAssetId: TAC, fromHeight: 500 });
  const c = pool.commitXY(AMOUNT, '0x' + BLINDING.toString(16).padStart(64, '0'));
  const compressed = (BigInt(c.cy) % 2n === 0n ? '02' : '03') + c.cx.replace(/^0x/, '').padStart(64, '0');
  const kinds = {
    burnhex: { type: 'burn', assetId: TAC, dest: '0x' + 'ee'.repeat(32) },
    homehex: { type: 'cxfer', assetId: TAC, vouts: [0, 1], commitments: [compressed, '02' + '33'.repeat(32)] },
  };
  const pub = hex(secp.getPublicKey(WALLET, true));
  const spk = verifier.ownerScript(pub);
  const txs = {
    [BURN]: { status: { confirmed: true, block_height: 900 }, vin: [{ txid: HOME, vout: 0, prevout: { scriptpubkey: '5120' + '44'.repeat(32) } }, { txid: FUND, vout: 1, prevout: { scriptpubkey: spk, scriptpubkey_address: 'bc1qholder' } }] },
    [HOME]: { status: { confirmed: true, block_height: 850 }, vin: [] },
    [PAID]: { status: { confirmed: false }, vout: [{ scriptpubkey: spk }, { scriptpubkey: '0014' + '99'.repeat(20) }] },
    [ELSE]: { status: { confirmed: true }, vout: [{ scriptpubkey: '0014' + '77'.repeat(20) }] },
  };
  const spends = {};
  const chain = {
    getTx: async (t) => txs[t] || null,
    getTxHex: async (t) => (t === BURN ? 'burnhex' : t === HOME ? 'homehex' : ''),
    outspend: async (t, v) => spends[`${t}:${v}`] || { spent: false },
  };
  const claim = { burnTxid: BURN, ...verifier.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET }), address: 'bc1qholder', status, at: 1, ...(inputs ? { inputs } : {}), sendingAt };
  const marks = [];
  const sends = [];
  const api = {
    claims: async () => [...ahead, claim],
    mark: async (burnTxid, st, extra = {}) => { if (refuseSending && st === 'sending') throw new Error('mark sending 409: that claim is sent'); marks.push({ burnTxid, status: st, ...extra }); Object.assign(claim, { status: st, ...extra }); },
  };
  const held = notes || [
    { txid: 'a1'.repeat(32), vout: 0, amount: 6000000000n },
    { txid: 'a2'.repeat(32), vout: 0, amount: 30000000000n },
    { txid: 'a3'.repeat(32), vout: 1, amount: 20000000000n },
  ];
  const wallet = { notes: async () => held, send: async (x) => { if (sendFails) throw new Error('the broadcast failed'); sends.push(x); return 'ab'.repeat(32); } };
  const leaf = pool.btcNoteLeaf(TAC, c.cx, c.cy, '0x' + '44'.repeat(32));        // the burn-home's output key; the reflection holds it, spent
  const state = async () => ({ height: stateHeight, dests, pending: new Set(), live, leaves: new Set([leaf.toLowerCase()]), spent: new Set([pool.nullifier(leaf).toLowerCase()]) });
  const before = { calls: 0, result: false };
  const rec = makeRecoverer({ verifier, pool, api, chain, state, wallet, beforeSend: async () => { before.calls++; return before.result; }, graceSecs: 600, now: () => nowMs });
  return { rec, marks, sends, spends, claim, pub, before };
}

test('a queued claim is marked with its notes, sent to the claim key for the exact amount, then marked sent', async () => {
  const w = world();
  const r = await w.rec.tick();
  assert.equal(r.sent, 1);
  assert.deepEqual(w.marks.map((m) => m.status), ['sending', 'sent']);
  assert.deepEqual(w.marks[0].inputs, [{ txid: 'a2'.repeat(32), vout: 0 }], 'one note covers it, the largest first');
  assert.equal(w.sends.length, 1);
  assert.equal(w.sends[0].pubHex, w.pub);
  assert.equal(w.sends[0].amount, AMOUNT);
  assert.equal(w.marks[1].txid, 'ab'.repeat(32));
});

test('untracked notes are chosen before tracked ones', async () => {
  const live = new Set([opKey('a2'.repeat(32), 0)]);
  const w = world({ live });
  await w.rec.tick();
  assert.deepEqual(w.marks[0].inputs, [{ txid: 'a3'.repeat(32), vout: 1 }], 'the tracked 300 TAC note is passed over for an untracked one');
});

test('a send cut short whose note was spent paying the claim is marked sent, not sent again', async () => {
  const w = world({ status: 'sending', inputs: [{ txid: 'a2'.repeat(32), vout: 0 }], sendingAt: 999_000 });
  w.spends[`${'a2'.repeat(32)}:0`] = { spent: true, txid: PAID };
  const r = await w.rec.tick();
  assert.equal(r.resolved, PAID);
  assert.equal(w.sends.length, 0);
  assert.deepEqual(w.marks.map((m) => [m.status, m.txid]), [['sent', PAID]]);
});

test('a send cut short with its notes unspent waits out the grace period, then goes out with the same notes', async () => {
  const early = world({ status: 'sending', inputs: [{ txid: 'a3'.repeat(32), vout: 1 }], sendingAt: 999_000 });
  assert.equal((await early.rec.tick()).waiting, BURN);
  assert.equal(early.sends.length, 0);
  const late = world({ status: 'sending', inputs: [{ txid: 'a3'.repeat(32), vout: 1 }], sendingAt: 1 });
  assert.equal((await late.rec.tick()).sent, 1);
  assert.deepEqual(late.sends[0].inputs.map((n) => n.txid), ['a3'.repeat(32)], 'the same note, so two sends cannot both confirm');
});

test('notes spent by something that does not pay the claim hold it for a person', async () => {
  const w = world({ status: 'sending', inputs: [{ txid: 'a2'.repeat(32), vout: 0 }], sendingAt: 1 });
  w.spends[`${'a2'.repeat(32)}:0`] = { spent: true, txid: ELSE };
  assert.equal((await w.rec.tick()).held, BURN);
  assert.equal(w.sends.length, 0);
  assert.equal(w.marks[0].status, 'held');
});

test('a claim that no longer checks out is held, and nothing is sent', async () => {
  const w = world({ dests: new Set(['0x' + 'ee'.repeat(32)]) });
  assert.equal((await w.rec.tick()).held, BURN);
  assert.equal(w.sends.length, 0);
  assert.match(w.marks[0].note, /completed/);
});

test('without enough TAC on hand it waits and marks nothing', async () => {
  const w = world({ notes: [{ txid: 'a1'.repeat(32), vout: 0, amount: 100n }] });
  assert.equal((await w.rec.tick()).short, BURN);
  assert.equal(w.sends.length, 0);
  assert.equal(w.marks.length, 0);
});

test('a fee top-up before a send makes the send wait a round', async () => {
  const w = world();
  w.before.result = true;
  assert.equal((await w.rec.tick()).toppedUp, true);
  assert.equal(w.sends.length, 0);
  assert.equal(w.marks.length, 0, 'nothing is marked sending before the money is there');
  w.before.result = false;
  assert.equal((await w.rec.tick()).sent, 1);
});

test('fee money: one top-up from the fee key when plain sats run low, never more often than six hours', async () => {
  const RECOVER = 'aa'.repeat(32), FEE = 'bb'.repeat(32);
  const addrOf = (pubHex) => 'bc1q-' + pubHex.slice(2, 10);
  const recoverAddr = addrOf(hex(secp.getPublicKey(Buffer.from(RECOVER, 'hex'), true)));
  let utxos = [{ value: 546 }, { value: 2000 }];
  const sent = [];
  const tacit = {
    DUST: 546, wallet: {}, invalidateHoldingsCache() {},
    getUtxos: async () => utxos,
    buildAndBroadcastSatsSend: async ({ recipientAddr, amountSats }) => { sent.push({ from: tacit.wallet.address(), recipientAddr, amountSats }); return { txid: 'cd'.repeat(32) }; },
  };
  Object.defineProperty(tacit.wallet, 'address', { value: () => addrOf(hex(tacit.wallet.pub)) });
  const { setWalletKey } = await import('../worker-relay/src/lib/headless-service.js');
  setWalletKey({ tacit, deps: vdeps }, RECOVER);
  let t = 0;
  const none = makeTopUp({ tacit, deps: vdeps, recoverKey: RECOVER, feeKey: null });
  assert.equal(await none(), false, 'no fee key, no top-up');
  const topUp = makeTopUp({ tacit, deps: vdeps, recoverKey: RECOVER, feeKey: FEE, minSats: 6000, topUpSats: 12000, now: () => t, logger: () => {} });
  assert.equal(await topUp(), true);
  assert.deepEqual(sent, [{ from: addrOf(hex(secp.getPublicKey(Buffer.from(FEE, 'hex'), true))), recipientAddr: recoverAddr, amountSats: 12000 }], 'sent from the fee key to the recovery key');
  assert.equal(tacit.wallet.address(), recoverAddr, 'the recovery key is back in place');
  t = 5 * 3600 * 1000;
  assert.equal(await topUp(), false, 'not again within six hours');
  utxos = [{ value: 9000 }];
  t = 7 * 3600 * 1000;
  assert.equal(await topUp(), false, 'not when enough plain sats are on hand (546-sat notes do not count)');
  assert.equal(sent.length, 1);
});

test('a mark the service refuses stops the send: nothing is paid', async () => {
  const w = world({ refuseSending: true });
  const r = await w.rec.tick();
  assert.equal(w.sends.length, 0);
  assert.notEqual(r.sent, 1);
});

test('a reason that clears by itself leaves the claim queued, not held', async () => {
  const w = world({ stateHeight: 899 });                          // the reflection has not reached the burn's block
  const r = await w.rec.tick();
  assert.equal(r.waiting, BURN);
  assert.equal(w.marks.length, 0, 'nothing is marked, so it is looked at again next round');
  assert.equal(w.sends.length, 0);
});

test('a claim held for good does not hold up the one behind it', async () => {
  const bad = { burnTxid: BURN, amount: '1', blinding: '1', pubkey: '02' + '11'.repeat(32), sig: '00'.repeat(64), address: 'bc1qbad', status: 'queued', at: 0 };
  const w = world({ before: [bad] });
  const r = await w.rec.tick();
  assert.deepEqual(w.marks.map((m) => m.status), ['held', 'sending', 'sent']);
  assert.equal(r.sent, 1);
  assert.equal(w.sends.length, 1);
});

test('while one claim is being sent, no other starts', async () => {
  const inflight = { burnTxid: 'c9'.repeat(32), amount: '1', blinding: '1', pubkey: '02' + '11'.repeat(32), sig: '00'.repeat(64), status: 'sending', at: 0, sendingAt: 999_900, inputs: [{ txid: 'a2'.repeat(32), vout: 0 }] };
  const w = world({ before: [inflight] });
  const r = await w.rec.tick();
  assert.equal(r.waiting, 'c9'.repeat(32));
  assert.equal(w.sends.length, 0);
});

test('a send whose notes left the wallet is not repeated with other notes while it may still be landing', async () => {
  const w = world({ status: 'sending', inputs: [{ txid: 'ff'.repeat(32), vout: 0 }], sendingAt: 1 });
  const r = await w.rec.tick();
  assert.equal(r.waiting, BURN);
  assert.equal(w.sends.length, 0);
  const old = world({ status: 'sending', inputs: [{ txid: 'ff'.repeat(32), vout: 0 }], sendingAt: 1, nowMs: 100_000_000 });
  assert.equal((await old.rec.tick()).held, BURN, 'and after hours with no sign of a payment it is held for a person');
  assert.equal(old.sends.length, 0);
});


test('a send that keeps failing is held for a person after three tries, not retried for ever', async () => {
  const w = world({ sendFails: true });
  await w.rec.tick(); await w.rec.tick();
  assert.notEqual(w.marks[w.marks.length - 1].status, 'held', 'two failures are still retried');
  await w.rec.tick();
  const last = w.marks[w.marks.length - 1];
  assert.equal(last.status, 'held');
  assert.match(last.note, /failed 3 times/);
  assert.equal(w.sends.length, 0);
});
