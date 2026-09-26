// /sats: sats paid to the pool wallet's exit keys (Back to sats) count as sats and move to the wallet with one
// sweep. Checks the P2TR address encoding, which exit-key outputs are plain sats (a pool spend's exit output is a
// cBTC note and stays put), and that the sweep transaction is signed by each exit key.
//   node tests/secret-sats-exit-sweep.test.mjs

import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { secp } from '../dapp/vendor/tacit-deps.min.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
Object.assign(globalThis, { window: dom.window, document: dom.window.document, localStorage: dom.window.localStorage, location: dom.window.location });
if (!globalThis.navigator) globalThis.navigator = dom.window.navigator;
globalThis.__TACIT_NO_INIT__ = true;
localStorage.setItem('tacit-network-v1', 'signet');

const T = await import('../dapp/tacit.js');
const secret = await import('../dapp/sats/secret.js');
const { pool } = secret;
const strip = (h) => String(h).replace(/^0x/, '').toLowerCase();
const hexToBytes = (h) => Uint8Array.from(strip(h).match(/../g).map((x) => parseInt(x, 16)));

// BIP-350 vector.
assert.equal(secret.p2trAddress('0x5120000000c4a5cad46221b2a187905e5266362b99d5e91c6ce24d165dab93e86433', 'signet'),
  'tb1pqqqqp399et2xygdj5xreqhjjvcmzhxw4aywxecjdzew6hylgvsesf3hn0c');
assert.equal(secret.p2trAddress('0x5120' + '79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798', 'mainnet'),
  'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0');

// Throwaway pool wallet.
const pw = secret.poolWalletFor(new Uint8Array(32).fill(9), 'signet');
const k0 = pool.deriveExitKey(pw, 0), k1 = pool.deriveExitKey(pw, 1);

// knownExitCount reads the Secret payment progress.
localStorage.setItem('tacit-sats-demo-v2:signet:ab', JSON.stringify({ sellUsed: ['0x11', '0x22'], sells: [{ payout: { counter: 3 } }] }));
assert.equal(secret.knownExitCount('signet', 'ab'), 4);
assert.equal(secret.knownExitCount('signet', 'cd'), 0);

// A pool spend exiting to vout 0 (a cBTC note) and wanting 380 sats at vout 1 (exit key 0).
const ASSET = '0x' + 'ab'.repeat(32);
const note = pool.createNote(pw.addressString, ASSET, 10_000n);
const [mine] = pool.scan(pw, [{ leafIndex: 0, leaf: note.leaf, asset: note.asset, pkEph: note.pkEph, ctNote: note.ctNote }]);
assert.ok(mine, 'scan finds the note');
const path = Array(32).fill('0x' + '00'.repeat(32));
const built = pool.buildSpendBody({
  asset: ASSET, hAnchor: 100, root: pool.merkleRootFrom(mine.leaf, 0, path), inputs: [{ ...mine, path }],
  exit: { exitVout: 0, scriptPubKey: '0x0014' + '77'.repeat(20) }, want: { vout: 1, value: 380n, scriptPubKey: k0.scriptPubKey }, usedScripts: new Set(),
});
const body = built.body instanceof Uint8Array ? built.body : hexToBytes(built.body);
const payload = new Uint8Array(body.length + 2 + 4);
payload.set(body); payload[body.length] = 4;
const spendTx = {
  txid: 'c0'.repeat(32),
  vout: [{ value: 546, scriptpubkey: '0014' + '77'.repeat(20) }, { value: 380, scriptpubkey: strip(k0.scriptPubKey) }, { value: 6000, scriptpubkey: strip(k1.scriptPubKey) }],
};
const stub = (env, pd = null) => ({ DUST: 546, txOutputEnvelope: () => env, getParentEnvelopeData: async () => pd });
const poolEnv = { opcode: 0x6d, payload };
assert.equal(await secret.isPlainSats(stub(poolEnv), spendTx, 0), false, 'exit output is a note');
assert.equal(await secret.isPlainSats(stub(poolEnv), spendTx, 1), true, 'want output below the dust band is sats');
assert.equal(await secret.isPlainSats(stub(poolEnv), spendTx, 2), true, 'other output above the dust band');
const badWant = { ...spendTx, vout: [spendTx.vout[0], { value: 380, scriptpubkey: strip(k1.scriptPubKey) }] };
assert.equal(await secret.isPlainSats(stub(poolEnv), badWant, 1), false, 'want to another script is not trusted');
assert.equal(await secret.isPlainSats(stub({ opcode: 0x6d, payload: payload.slice(0, 40) }), spendTx, 1), false, 'unparsable pool payload fails closed');
assert.equal(await secret.isPlainSats(stub({ opcode: 0x22, payload: new Uint8Array(1) }, { assetIdHex: 'ab' }), spendTx, 2), false, 'classic note');
assert.equal(await secret.isPlainSats(stub(null), { vout: [{ value: 546, scriptpubkey: '' }] }, 0), false, 'dust band without an envelope');
assert.equal(await secret.isPlainSats(stub(null), { vout: [{ value: 1000, scriptpubkey: '' }] }, 0), true);

// Sweep: two exit-key coins to the wallet's P2WPKH, each input a valid BIP-340 key-path signature.
const coins = [
  { txid: 'c0'.repeat(32), vout: 1, value: 570, counter: 0, spk: strip(k0.scriptPubKey) },
  { txid: 'c1'.repeat(32), vout: 1, value: 380, counter: 1, spk: strip(k1.scriptPubKey) },
];
const toScript = T.p2wpkhScript(secp.getPublicKey(new Uint8Array(32).fill(7), true));
const deps = { signKeyPath: T.signTaprootKeyPathInputWithKey, serializeTx: T.serializeTx, txid: T.txid, dust: T.DUST };
const b = secret.buildSweep({ poolWallet: pw, coins, toScript, feeRate: 1, ...deps });
assert.equal(b.fee, secret.sweepVbytes(2));
assert.equal(b.value, 950 - b.fee);
assert.equal(b.tx.outputs.length, 1);
const prevouts = coins.map((c) => ({ value: c.value, script: hexToBytes(c.spk) }));
coins.forEach((c, i) => {
  const [sig] = b.tx.inputs[i].witness;
  assert.equal(sig.length, 64);
  const msg = T.tapSighashKeyPath(b.tx, i, prevouts, 0);
  assert.ok(pool.schnorrVerify(sig, msg, hexToBytes(c.spk).slice(2)) && T.verifySchnorr(sig, msg, hexToBytes(c.spk).slice(2)), `input ${i} signature`);
});
// The serialized size matches the estimate within a vbyte per input.
const wu = T.serializeTx(b.tx, false).length * 3 + T.serializeTx(b.tx).length;
assert.ok(Math.abs(Math.ceil(wu / 4) - secret.sweepVbytes(2)) <= 2, `vsize ${Math.ceil(wu / 4)} vs ${secret.sweepVbytes(2)}`);
assert.equal(b.txid, T.txid(b.tx));
assert.throws(() => secret.buildSweep({ poolWallet: pw, coins: [coins[1]], toScript, feeRate: 1, ...deps }), /too little to move/);
assert.throws(() => secret.buildSweep({ poolWallet: pw, coins: [{ ...coins[0], value: 5000, counter: 1 }], toScript, feeRate: 1, ...deps }), /does not match/);

// A lone small payout is topped up with one of the wallet's own coins so the output clears the dust band.
T.wallet.priv = new Uint8Array(32).fill(7);
T.wallet.pub = secp.getPublicKey(T.wallet.priv, true);
const walletCoin = { txid: 'd0'.repeat(32), vout: 0, value: 2000 };
const t = secret.buildSweep({ poolWallet: pw, coins: [coins[1]], walletCoins: [walletCoin], toScript, feeRate: 1, signWallet: T.signP2wpkhInput, ...deps });
assert.equal(t.fee, secret.sweepVbytes(1, 1));
assert.equal(t.value, 380 + 2000 - t.fee);
assert.equal(t.tx.inputs.length, 2);
assert.equal(t.tx.inputs[1].witness.length, 2, 'P2WPKH witness');
const pv2 = [{ value: 380, script: hexToBytes(coins[1].spk) }, { value: 2000, script: toScript }];
assert.ok(pool.schnorrVerify(t.tx.inputs[0].witness[0], T.tapSighashKeyPath(t.tx, 0, pv2, 0), hexToBytes(coins[1].spk).slice(2)), 'exit input signs over both prevouts');
const wu2 = T.serializeTx(t.tx, false).length * 3 + T.serializeTx(t.tx).length;
assert.ok(Math.abs(Math.ceil(wu2 / 4) - secret.sweepVbytes(1, 1)) <= 2, `vsize ${Math.ceil(wu2 / 4)}`);

console.log('secret-sats-exit-sweep: ok');
process.exit(0);
