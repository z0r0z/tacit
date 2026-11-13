// The Bitcoin transactions of a cBTC lock, checked by code that shares nothing with the dapp: bitcoinjs-lib parses them and works out
// the sighashes and the taproot commitments, and libsecp256k1 (tiny-secp256k1) verifies the signatures. Covered: a lock's commit and
// reveal, the take-back of a lock nothing was minted on, a reveal signed again from its commit and the key alone, and a redeem's commit
// and reveal. The amounts' commitments are the real pool's.
//
// The two libraries are not dependencies of this repo. With them installed anywhere node can resolve them from here (or from
// CROSSCHECK_MODULES=<a directory holding node_modules>), this runs; without them it says so and passes nothing:
//   npm i --no-save bitcoinjs-lib@6 tiny-secp256k1@2 && node tests/cbtc-lock-crosscheck.mjs
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(process.env.CROSSCHECK_MODULES ? join(process.env.CROSSCHECK_MODULES, 'x.js') : import.meta.url);
let bitcoin, bip341, ecc;
try { bitcoin = require('bitcoinjs-lib'); bip341 = require('bitcoinjs-lib/src/payments/bip341'); ecc = require('tiny-secp256k1'); }
catch { console.log('skipped: bitcoinjs-lib and tiny-secp256k1 are not installed (npm i --no-save bitcoinjs-lib@6 tiny-secp256k1@2)'); process.exit(0); }
bitcoin.initEccLib(ecc);

const mem = new Map();
globalThis.localStorage = { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) };
const realSetTimeout = globalThis.setTimeout;
globalThis.setTimeout = (f, ms, ...a) => realSetTimeout(f, Math.min(ms || 0, 1), ...a);          // the retries' waits, not waited
const { sha256, hmac, secp, keccak_256, bytesToHex, hexToBytes } = await import('../dapp/vendor/tacit-deps.min.js');
const { makeConfidentialPool } = await import('../dapp/confidential-pool.js');
const { makeLoans } = await import('../dapp/btc-borrow.js');
const { makeCbtcLockMint } = await import('../dapp/cbtc-lock-mint.js');
const { makeCbtcRedeem, CBTC_ZK_ASSET_ID } = await import('../dapp/cbtc-redeem.js');

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256 });
const priv = new Uint8Array(32).fill(0x2a);
const utxos = [{ txid: 'a1'.repeat(32), vout: 0, value: 300000, status: { confirmed: true } }, { txid: 'a2'.repeat(32), vout: 1, value: 120000, status: { confirmed: true } }];
const posts = [], known = new Set();
let revealOk = true;
const idOf = (h) => Buffer.from(h).reverse().toString('hex');
// Bitcoin's explorers, as far as the driver asks them: the coins, a fee estimate, and a mempool that takes what is posted
globalThis.fetch = async (url, o = {}) => {
  const u = String(url), json = (x) => new Response(JSON.stringify(x), { status: 200 });
  if (o.method === 'POST' && u.endsWith('/tx')) {
    const hex = String(o.body), tx = bitcoin.Transaction.fromHex(hex), isReveal = tx.ins.length === 1 && known.has(idOf(tx.ins[0].hash));
    if (!posts.includes(hex)) posts.push(hex);
    if (isReveal && !revealOk) return new Response('refused for the test', { status: 400 });
    known.add(tx.getId());
    return new Response(tx.getId(), { status: 200 });
  }
  if (/\/address\/[a-z0-9]+\/utxo$/.test(u)) return json(utxos);
  if (u.endsWith('/fee-estimates')) return json({ 2: 6 });
  if (/\/tx\/[0-9a-f]{64}\/outspend\/\d+$/.test(u)) return json({ spent: false });
  if (/\/tx\/[0-9a-f]{64}\/status$/.test(u)) return json({ confirmed: false });
  const tx = u.match(/\/tx\/([0-9a-f]{64})$/);
  if (tx) return known.has(tx[1]) ? json({ txid: tx[1] }) : new Response('Transaction not found', { status: 404 });
  return new Response('not found', { status: 404 });
};
const t = { syncCbtcLockReservations: async () => {}, cfg: { pool: '0xpool', collateralEngine: '0xengine' }, cbtcLockState: async () => ({ spent: false, redeemed: false }),
  ethCall: async () => '0x' + '0'.repeat(64), pool: { CBTC_ZK_ASSET_ID, commitXY: pool.commitXY, outpointKey: pool.outpointKey } };
const LN = makeLoans({ sha256, hmac, secp, bytesToHex, hexToBytes, pubHex: () => 'crosscheck',
  lockModule: () => import('../dapp/cbtc-lock-mint.js'), deployments: () => import('../dapp/confidential-deployments.js'), redeemModule: () => import('../dapp/cbtc-redeem.js') });
const lm = makeCbtcLockMint({ priv, pool: t.pool, cbtcAsset: CBTC_ZK_ASSET_ID }), P = lm.prims;
const pub = Buffer.from(P.wallet.pub), xonly = pub.subarray(1), homeSpk = Buffer.from(P.p2wpkhScript(P.wallet.pub)), lockSpk = Buffer.from(lm.ownLockScriptPubKey());

let n = 0, bad = 0;
const ok = (c, what) => { if (c) n++; else bad++; console.log(c ? 'ok  ' : 'FAIL', what); };

// each P2WPKH input signed by the key, over bitcoinjs-lib's BIP-143 sighash
function wpkhInputs(hex, coins) {
  const tx = bitcoin.Transaction.fromHex(hex), code = bitcoin.payments.p2pkh({ pubkey: pub }).output;
  return tx.ins.every((inp, i) => {
    const c = coins.find((x) => x.txid === idOf(inp.hash) && x.vout === inp.index), [sig, pk] = inp.witness;
    const { signature, hashType } = bitcoin.script.signature.decode(sig);
    return !!c && pk.equals(pub) && hashType === bitcoin.Transaction.SIGHASH_ALL && ecc.verify(tx.hashForWitnessV0(i, code, c.value, hashType), pub, signature);
  });
}
// input `i` of `r` as a script-path spend of `prev` (BIP-341): the control block's internal key, tweaked by the leaf, is the output key
// `prev` pays; the script's first push is the key that signs, and it signed bitcoinjs-lib's script-path sighash
function scriptPath(r, i, scripts, values) {
  const [sig, script, control] = r.ins[i].witness, leaf = bip341.tapleafHash({ output: script, version: control[0] & 0xfe });
  const internal = control.subarray(1, 33), q = ecc.xOnlyPointAddTweak(internal, bip341.tapTweakHash(internal, leaf));
  const commits = control.length === 33 && !!q && scripts[i].equals(Buffer.concat([Buffer.from([0x51, 0x20]), Buffer.from(q.xOnlyPubkey)])) && (control[0] & 1) === q.parity;
  const signer = script.subarray(1, 33), h = r.hashForWitnessV1(i, scripts, values, bitcoin.Transaction.SIGHASH_DEFAULT, leaf);
  return { commits, signed: script[0] === 0x20 && signer.equals(xonly) && sig.length === 64 && ecc.verifySchnorr(h, signer, sig) };
}
// input `i` of `r` as a key-path spend: one 64-byte signature by the output key itself
const keyPath = (r, i, scripts, values) => r.ins[i].witness.length === 1 && r.ins[i].witness[0].length === 64
  && ecc.verifySchnorr(r.hashForWitnessV1(i, scripts, values, bitcoin.Transaction.SIGHASH_DEFAULT), scripts[i].subarray(2), r.ins[i].witness[0]);
function lockReveal(commitHex, revealHex, sats) {
  const c = bitcoin.Transaction.fromHex(commitHex), r = bitcoin.Transaction.fromHex(revealHex);
  const sp = scriptPath(r, 0, [c.outs[0].script], [c.outs[0].value]);
  return { spendsCommit: r.ins.length === 1 && idOf(r.ins[0].hash) === c.getId() && r.ins[0].index === 0, ...sp,
    pays: r.outs.length === 2 && r.outs[0].value === 546 && r.outs[0].script.equals(homeSpk) && r.outs[1].value === sats && r.outs[1].script.equals(lockSpk),
    fee: c.outs[0].value - r.outs.reduce((a, o) => a + o.value, 0), vsize: r.virtualSize() };
}
const all = (o) => o.spendsCommit && o.commits && o.signed && o.pays;

ok(bitcoin.payments.p2wpkh({ pubkey: pub }).output.equals(homeSpk), 'the deposit script is the key’s P2WPKH, as bitcoinjs-lib derives it');
ok(bitcoin.payments.p2tr({ internalPubkey: xonly }).output.equals(lockSpk), 'the lock script is the key’s key-path-only taproot output (BIP-86), as bitcoinjs-lib derives it');

// ── a lock: its commit and its reveal ──
const lock = (await LN.lock(t, priv, { sats: 250000n, rate: 6 })).record;
ok(posts.length === 2 && wpkhInputs(posts[0], utxos), 'lock commit: every input’s ECDSA signature verifies');
const r1 = lockReveal(posts[0], posts[1], 250000), cv = bitcoin.Transaction.fromHex(posts[0]);
ok(all(r1), `lock reveal: spends the commit, the control block commits the envelope script to the commit’s output key, the script’s key signed, and it pays the dust output and the lock (${JSON.stringify(r1)})`);
const commitFee = utxos.filter((u) => cv.ins.some((i) => idOf(i.hash) === u.txid && i.index === u.vout)).reduce((a, u) => a + u.value, 0) - cv.outs.reduce((a, o) => a + o.value, 0);
ok(r1.fee / r1.vsize >= 6 && commitFee / cv.virtualSize() >= 6, `both pay at least the 6 sat/vB asked, by bitcoinjs-lib’s sizes (commit ${commitFee}/${cv.virtualSize()} vB, reveal ${r1.fee}/${r1.vsize} vB)`);
ok(bitcoin.Transaction.fromHex(posts[1]).getId() === lock.lockTxid, 'the lock’s txid is the reveal’s');

// ── the take-back: a key-path spend of the lock's output ──
const back = await LN.takeBack(t, priv, lock, { rate: 6 });
{
  const u = bitcoin.Transaction.fromHex(posts[2]);
  ok(u.ins.length === 1 && idOf(u.ins[0].hash) === lock.lockTxid && u.ins[0].index === 1 && keyPath(u, 0, [lockSpk], [250000]), 'take-back: one input, the lock’s output, signed by its output key');
  ok(u.outs.length === 1 && u.outs[0].script.equals(homeSpk) && u.outs[0].value === 250000 - back.fee && back.fee / u.virtualSize() >= 6, `take-back: all of it less the fee, to the key’s deposit script (${back.fee} sats / ${u.virtualSize()} vB)`);
}

// ── a lock cut short, its reveal signed again from the commit and the key ──
posts.length = 0; known.clear(); mem.clear(); revealOk = false;
utxos.length = 0; utxos.push({ txid: 'b7'.repeat(32), vout: 2, value: 400000, status: { confirmed: true } });
await LN.lock(t, priv, { sats: 180000n, rate: 9 }).catch(() => {});
const ct = bitcoin.Transaction.fromHex(posts[0]);
mem.clear(); revealOk = true;
const found = await lm.lockOfCommit({ txid: ct.getId(), value: ct.outs[0].value, script: ct.outs[0].script.toString('hex'), anchor: { txid: utxos[0].txid, vout: utxos[0].vout } });
ok(found?.vBtc === '180000' && all(lockReveal(posts[0], found.revealHex, 180000)), 'read back from its commit: the amount is found and the reveal signed again is valid by the same rules');
ok(!!found && bitcoin.Transaction.fromHex(found.revealHex).getId() === bitcoin.Transaction.fromHex(posts[1]).getId(), 'and it is the transaction first signed, by txid');

// ── a redeem: the commit, and the reveal that spends it, the lock and the cBTC notes ──
{
  const R = makeCbtcRedeem({ pool, secp, sha256, prims: P }), x = bytesToHex(xonly), noteSpk = Buffer.from('5120' + x, 'hex');
  const rlock = { txid: 'aa'.repeat(32), vout: 1, value: 100000, spk: lockSpk.toString('hex') };
  const notes = [{ txid: 'bb'.repeat(32), vout: 0, sats: 546, amount: 40000n, blinding: 0x1111111111111111n, assetId: CBTC_ZK_ASSET_ID }, { txid: 'cc'.repeat(32), vout: 0, sats: 546, amount: 60000n, blinding: 0x2222222222222222n, assetId: CBTC_ZK_ASSET_ID }];
  const funding = [{ txid: 'dd'.repeat(32), vout: 0, value: 50000 }];
  const built = R.buildRedeemTxs({ prims: P, lock: rlock, notes, funding, feeRate: 4 });
  const c = bitcoin.Transaction.fromHex(built.commitHex), r = bitcoin.Transaction.fromHex(built.revealHex);
  ok(wpkhInputs(built.commitHex, funding), 'redeem commit: every input’s ECDSA signature verifies');
  const scripts = [c.outs[0].script, lockSpk, noteSpk, noteSpk], values = [c.outs[0].value, 100000, 546, 546];
  const order = r.ins.map((i) => `${idOf(i.hash)}:${i.index}`).join() === [`${c.getId()}:0`, 'aa'.repeat(32) + ':1', 'bb'.repeat(32) + ':0', 'cc'.repeat(32) + ':0'].join();
  const sp = scriptPath(r, 0, scripts, values);
  ok(order && sp.commits && sp.signed, 'redeem reveal: the commit first (its envelope script committed and signed), then the lock, then the notes');
  ok(keyPath(r, 1, scripts, values), 'redeem reveal: the lock’s input is signed by the lock’s output key');
  ok(keyPath(r, 2, scripts, values) && keyPath(r, 3, scripts, values), 'redeem reveal: each cBTC note’s input is signed by the key the note sits at');
  const fee = values.reduce((a, v) => a + v, 0) - r.outs.reduce((a, o) => a + o.value, 0);
  ok(r.outs[0].script.equals(homeSpk) && r.outs.length === 1 && r.outs[0].value === built.outputSats && fee / r.virtualSize() >= 4, `redeem reveal: the lock’s BTC comes back to the key’s deposit script, at the rate asked (${fee} sats / ${r.virtualSize()} vB)`);
}

console.log(bad ? `\n${bad} failed, ${n} passed` : `\n${n} passed`);
process.exit(bad ? 1 : 0);
