// worker-relay/src/bridge-recover.js: a send still landing holds its notes. Two claims of one holder key: A is 'sending' (grace passed) and its re-send fails once, so B (queued) is
// attempted in the same tick; B must not pick A's notes (a payment to the key for B would read as A's, and A would be marked sent with B's transaction).
// (was a probe: two claims of ONE holder key; A is 'sending' (grace passed) and its re-send fails once, so B (queued) is attempted in the same
// tick and re-picks A's notes. Then A's paidBy sees its notes spent by B's payment (which pays the same key) and marks A 'sent'.
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
import { makeRecoverer } from '../worker-relay/src/bridge-recover.js';

const rep = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(sha256, key, _cat(m));
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const hex = (b) => Buffer.from(b).toString('hex');
const WALLET = new Uint8Array(32).fill(0x31);
const AMT_A = 10000000000n, AMT_B = 5000000000n, BL = 0x1234567890abcdefn;
const BURN_A = 'b1'.repeat(32), BURN_B = 'b2'.repeat(32), HOME_A = 'c1'.repeat(32), HOME_B = 'c2'.repeat(32), FUND = 'd3'.repeat(32), PAID_B = 'e4'.repeat(32);

const verifier = makeBridgeRecover({ secp, sha256, ripemd160, pool, classifyConfidentialTx: (h) => kinds[h.replace(/^0x/, '')] || null, signSchnorr, verifySchnorr, tacAssetId: TAC, fromHeight: 500 });
const cm = (amt) => { const c = pool.commitXY(amt, '0x' + BL.toString(16).padStart(64, '0')); return { c, comp: (BigInt(c.cy) % 2n === 0n ? '02' : '03') + c.cx.replace(/^0x/, '').padStart(64, '0') }; };
const cA = cm(AMT_A), cB = cm(AMT_B);
const kinds = {
  burnA: { type: 'burn', assetId: TAC, dest: '0x' + 'ea'.repeat(32) },
  burnB: { type: 'burn', assetId: TAC, dest: '0x' + 'eb'.repeat(32) },
  homeA: { type: 'cxfer', assetId: TAC, vouts: [0, 1], commitments: [cA.comp, '02' + '33'.repeat(32)] },
  homeB: { type: 'cxfer', assetId: TAC, vouts: [0, 1], commitments: [cB.comp, '02' + '33'.repeat(32)] },
};
const pub = hex(secp.getPublicKey(WALLET, true));
const spk = verifier.ownerScript(pub);
const mkBurn = (home) => ({ status: { confirmed: true, block_height: 900 }, vin: [{ txid: home, vout: 0, prevout: { scriptpubkey: '5120' + '44'.repeat(32) } }, { txid: FUND, vout: 1, prevout: { scriptpubkey: spk, scriptpubkey_address: 'bc1qholder' } }] });
const txs = {
  [BURN_A]: mkBurn(HOME_A), [BURN_B]: mkBurn(HOME_B),
  [HOME_A]: { status: { confirmed: true, block_height: 850 }, vin: [] }, [HOME_B]: { status: { confirmed: true, block_height: 850 }, vin: [] },
  [PAID_B]: { status: { confirmed: false }, vout: [{ scriptpubkey: spk }, { scriptpubkey: '0014' + '99'.repeat(20) }] },
};
const spends = {};
const chain = { getTx: async (t) => txs[t] || null, getTxHex: async (t) => (t === BURN_A ? 'burnA' : t === BURN_B ? 'burnB' : t === HOME_A ? 'homeA' : t === HOME_B ? 'homeB' : ''), outspend: async (t, v) => spends[`${t}:${v}`] || { spent: false } };
const mkClaim = (burn, amt, extra) => ({ burnTxid: burn, ...verifier.buildClaim({ burnTxid: burn, amount: amt, blinding: BL, walletPriv: WALLET }), address: 'bc1qholder', at: extra.at, ...extra });
const A = mkClaim(BURN_A, AMT_A, { status: 'sending', inputs: [{ txid: 'a2'.repeat(32), vout: 0 }], sendingAt: 1, at: 1 });
const B = mkClaim(BURN_B, AMT_B, { status: 'queued', at: 2 });
const marks = [];
const api = {
  claims: async () => [A, B],
  mark: async (burnTxid, st, extra = {}) => { marks.push({ burnTxid: burnTxid.slice(0, 2), status: st, ...extra }); Object.assign(burnTxid === BURN_A ? A : B, { status: st, ...extra }); },
};
const held = [{ txid: 'a2'.repeat(32), vout: 0, amount: 30000000000n }, { txid: 'a1'.repeat(32), vout: 0, amount: 6000000000n }];
let sendCalls = 0;
const sends = [];
const wallet = { notes: async () => held, send: async (x) => { sendCalls++; if (sendCalls === 1) throw new Error('transient: the broadcast failed'); sends.push({ amount: x.amount, inputs: x.inputs.map((n) => n.txid.slice(0, 2)) }); return 'ab'.repeat(32); } };
const leafOf = (c) => pool.btcNoteLeaf(TAC, c.cx, c.cy, '0x' + '44'.repeat(32));
const lA = leafOf(cA.c), lB = leafOf(cB.c);
const state = async () => ({ height: 1000, dests: new Set(), pending: new Set(), live: new Set(), leaves: new Set([lA.toLowerCase(), lB.toLowerCase()]), spent: new Set([pool.nullifier(lA).toLowerCase(), pool.nullifier(lB).toLowerCase()]) });
const rec = makeRecoverer({ verifier, pool, api, chain, state, wallet, beforeSend: async () => false, graceSecs: 600, now: () => 1_000_000 });


test('a claim sent while another claim\u2019s send may still land does not take that claim\u2019s notes', async () => {
  const r1 = await rec.tick();
  assert.equal(r1.sent, 1, 'B is sent in the tick in which A\u2019s re-send failed');
  assert.equal(sends.length, 1);
  assert.ok(sends[0].inputs.every((i) => !String(i.txid || i).startsWith('a2a2')), 'B was sent from other notes than A\u2019s reserved a2');
  const bMark = marks.find((m) => m.burnTxid === 'b2' && m.status === 'sending');
  assert.ok(bMark && bMark.inputs.every((i) => !i.txid.startsWith('a2a2')), 'B was marked sending with notes of its own');
  assert.notEqual(A.status, 'sent', 'A is not resolved by B\u2019s payment');
});
