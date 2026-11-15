// dapp/bridge-recover.js: a claim to recover a bridge that did not complete is accepted only for that bridge's own
// holder, for the exact amount its burned note carried, and only when the reflection passed the burn without
// recording it.
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

const _cat = (arrs) => { const t = arrs.reduce((s, a) => s + a.length, 0); const o = new Uint8Array(t); let p = 0; for (const a of arrs) { o.set(a, p); p += a.length; } return o; };
secp.etc.hmacSha256Sync = (key, ...m) => hmac(sha256, key, _cat(m));
const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const TAC = '0xf0bbe868af10c6c67652a99709bf32048d1aa7194efe3e9a1ef1bde43f94762b';
const hex = (b) => Buffer.from(b).toString('hex');

const WALLET = new Uint8Array(32).fill(0x31), OTHER = new Uint8Array(32).fill(0x32);
const AMOUNT = 10000000000n, BLINDING = 0x1234567890abcdefn;          // 100 TAC
const BURN = 'b1'.repeat(32), HOME = 'c2'.repeat(32), FUND = 'd3'.repeat(32);
const DEST = '0x' + 'ee'.repeat(32);
const ZERO32 = '0x' + '00'.repeat(32);
// The attested state a real burned note leaves: its leaf in the note tree and its nullifier in the spent set.
const noteState = (auth, height = 1000) => {
  const c = pool.commitXY(AMOUNT, '0x' + BLINDING.toString(16).padStart(64, '0'));
  const leaf = pool.btcNoteLeaf(TAC, c.cx, c.cy, auth);
  return { height, dests: new Set(), pending: new Set(), leaves: new Set([leaf.toLowerCase()]), spent: new Set([pool.nullifier(leaf).toLowerCase()]) };
};

function world({ height = 900, payer = WALLET } = {}) {
  const r = makeBridgeRecover({ secp, sha256, ripemd160, pool, classifyConfidentialTx: (h) => kinds[h.replace(/^0x/, '')] || null, signSchnorr, verifySchnorr, tacAssetId: TAC, fromHeight: 500 });
  const c = pool.commitXY(AMOUNT, '0x' + BLINDING.toString(16).padStart(64, '0'));
  const compressed = (BigInt(c.cy) % 2n === 0n ? '02' : '03') + c.cx.replace(/^0x/, '').padStart(64, '0');
  const kinds = {
    burnhex: { type: 'burn', assetId: TAC, dest: DEST, nullifier: '0x' + '11'.repeat(32), target: '0x' + '22'.repeat(32) },
    homehex: { type: 'cxfer', assetId: TAC, vouts: [0, 1], commitments: [compressed, '02' + '33'.repeat(32)] },
  };
  const payerSpk = r.ownerScript(hex(secp.getPublicKey(payer, true)));
  const txs = {
    [BURN]: { status: { confirmed: true, block_height: height }, vin: [{ txid: HOME, vout: 0, prevout: { scriptpubkey: '5120' + '44'.repeat(32) } }, { txid: FUND, vout: 1, prevout: { scriptpubkey: payerSpk, scriptpubkey_address: 'bc1qholder' } }] },
    [HOME]: { status: { confirmed: true, block_height: height - 50 }, vin: [{ txid: 'aa'.repeat(32), vout: 0, prevout: { scriptpubkey: payerSpk, scriptpubkey_address: 'bc1qholder' } }] },
  };
  const chain = { getTx: async (t) => txs[t] || null, getTxHex: async (t) => (t === BURN ? 'burnhex' : t === HOME ? 'homehex' : '') };
  const state = noteState('0x' + '44'.repeat(32));            // the burn-home sits at a P2TR output of that key
  return { r, chain, state };
}

test('the holder recovers the exact amount of a burn the reflection passed without recording', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  const v = await r.verifyClaim(claim, { ...chain, state });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.amount, AMOUNT);
  assert.equal(v.address, 'bc1qholder');
  assert.equal(v.pubkey, hex(secp.getPublicKey(WALLET, true)));
});

test('a different amount does not open the burned note', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT + 1n, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(claim, { ...chain, state })).reason, /do not open/);
});

test('another key cannot claim it, even with the opening', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: OTHER });
  assert.match((await r.verifyClaim(claim, { ...chain, state })).reason, /did not make/);
});

test('a claim whose signature does not match is refused', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  claim.sig = claim.sig.slice(0, -2) + (claim.sig.endsWith('00') ? '01' : '00');
  assert.match((await r.verifyClaim(claim, { ...chain, state })).reason, /signature/);
  const other = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  other.amount = (AMOUNT * 2n).toString();
  assert.match((await r.verifyClaim(other, { ...chain, state })).reason, /signature/, 'the amount is part of what is signed');
});

test('a completed, pending, or not yet passed bridge is not recoverable', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(claim, { ...chain, state: { ...state, dests: new Set([DEST]) } })).reason, /completed/);
  const key = String(pool.outpointKey('0x' + HOME.match(/../g).reverse().join(''), 0)).toLowerCase();
  assert.match((await r.verifyClaim(claim, { ...chain, state: { ...state, pending: new Set([key]) } })).reason, /pending/);
  const later = world({ height: 1001 });
  assert.match((await later.r.verifyClaim(claim, { ...later.chain, state: later.state })).reason, /not yet passed/);
});

test('amounts above what one note holds are refused before anything is fetched, and a bridge has no cap below it', async () => {
  const { r, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: 10n ** 18n + 1n, blinding: BLINDING, walletPriv: WALLET });
  let fetched = false;
  const v = await r.verifyClaim(claim, { getTx: async () => { fetched = true; return null; }, getTxHex: async () => '', state });
  assert.match(v.reason, /out of range/);
  assert.equal(fetched, false);
  // the bridge's own cap of 1,000 TAC (1e11 units) is gone: an amount above it is read like any other, and only fails here for what the world holds
  const big = r.buildClaim({ burnTxid: BURN, amount: 100000000001n, blinding: BLINDING, walletPriv: WALLET });
  fetched = false;
  const w = await r.verifyClaim(big, { getTx: async () => { fetched = true; return null; }, getTxHex: async () => '', state });
  assert.doesNotMatch(w.reason, /out of range/);
  assert.equal(fetched, true, 'its burn is looked up');
});

test('a burn from before the in-app bridge is not recoverable here', async () => {
  const { r, chain, state } = world({ height: 499 });
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(claim, { ...chain, state })).reason, /predates/);
});

test('a burn of a tracked note (envelope commit first, the note second) is recovered the same way', async () => {
  const r = makeBridgeRecover({ secp, sha256, ripemd160, pool, classifyConfidentialTx: (h) => kinds[h.replace(/^0x/, '')] || null, signSchnorr, verifySchnorr, tacAssetId: TAC, fromHeight: 500 });
  const c = pool.commitXY(AMOUNT, '0x' + BLINDING.toString(16).padStart(64, '0'));
  const compressed = (BigInt(c.cy) % 2n === 0n ? '02' : '03') + c.cx.replace(/^0x/, '').padStart(64, '0');
  const COMMIT = 'f1'.repeat(32), NOTETX = 'f2'.repeat(32);
  const kinds = {
    burnhex: { type: 'burn', assetId: TAC, dest: DEST },
    commithex: null,
    notehex: { type: 'cxfer', assetId: TAC, vouts: [0, 1], commitments: ['02' + '33'.repeat(32), compressed] },
  };
  const spk = r.ownerScript(hex(secp.getPublicKey(WALLET, true)));
  const txs = {
    [BURN]: { status: { confirmed: true, block_height: 900 }, vin: [{ txid: COMMIT, vout: 0, prevout: { scriptpubkey: '5120' + '55'.repeat(32) } }, { txid: NOTETX, vout: 1, prevout: { scriptpubkey: spk, scriptpubkey_address: 'bc1qholder' } }] },
    [NOTETX]: { status: { confirmed: true, block_height: 850 }, vin: [] },
  };
  const chain = { getTx: async (t) => txs[t] || null, getTxHex: async (t) => (t === BURN ? 'burnhex' : t === COMMIT ? 'commithex' : t === NOTETX ? 'notehex' : '') };
  const state = noteState(ZERO32);                           // a tracked note at the holder's own P2WPKH output has no auth key
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  const v = await r.verifyClaim(claim, { ...chain, state });
  assert.equal(v.ok, true, v.reason);
  assert.equal(v.address, 'bc1qholder');
  const wrong = r.buildClaim({ burnTxid: BURN, amount: AMOUNT - 1n, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(wrong, { ...chain, state })).reason, /do not open/);
});

test('a note that is not one the reflection tracks is refused: a forged transfer cannot be refunded', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(claim, { ...chain, state: { ...state, leaves: new Set() } })).reason, /not one the reflection tracks/);
});

test('a tracked note that this burn did not leave spent is refused', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(claim, { ...chain, state: { ...state, spent: new Set() } })).reason, /not spent by this burn/);
});

test('the same opening under a key the output is not locked to finds no tracked note', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await r.verifyClaim(claim, { ...chain, state: noteState('0x' + '45'.repeat(32)) })).reason, /not one the reflection tracks/);
});

test('a burned note of another asset is refused', async () => {
  const { r, chain, state } = world();
  const other = makeBridgeRecover({ secp, sha256, ripemd160, pool, tacAssetId: TAC, signSchnorr, verifySchnorr, fromHeight: 500,
    classifyConfidentialTx: (h) => (/homehex/.test(h) ? { type: 'cxfer', assetId: '0x' + '11'.repeat(32), vouts: [0, 1], commitments: ['02' + '33'.repeat(32), '02' + '33'.repeat(32)] }
      : { type: 'burn', assetId: TAC, dest: DEST }) });
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  assert.match((await other.verifyClaim(claim, { ...chain, state })).reason, /not TAC/);
});

test('whoever only funded the transaction that made the note cannot claim the burn', async () => {
  const { r, chain, state } = world();
  const SENDER = new Uint8Array(32).fill(0x33);
  const senderSpk = r.ownerScript(hex(secp.getPublicKey(SENDER, true)));
  // The note was made by a transaction the sender funded; the burn itself is the holder's.
  const home = await chain.getTx(HOME);
  home.vin = [{ txid: 'aa'.repeat(32), vout: 0, prevout: { scriptpubkey: senderSpk, scriptpubkey_address: 'bc1qsender' } }];
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: SENDER });
  assert.match((await r.verifyClaim(claim, { ...chain, state })).reason, /did not make/);
});

test('a note already moved to Ethereum another way is not refunded on Bitcoin as well', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  const key = String(pool.outpointKey('0x' + HOME.match(/../g).reverse().join(''), 0)).toLowerCase();
  assert.match((await r.verifyClaim(claim, { ...chain, state: { ...state, consumed: new Set([key]) } })).reason, /already moved to Ethereum/);
});

test('without the reflection state\'s note tree and spent set nothing is refunded', async () => {
  const { r, chain, state } = world();
  const claim = r.buildClaim({ burnTxid: BURN, amount: AMOUNT, blinding: BLINDING, walletPriv: WALLET });
  const { leaves, spent, ...bare } = state;
  assert.match((await r.verifyClaim(claim, { ...chain, state: bare })).reason, /not available/);
});
