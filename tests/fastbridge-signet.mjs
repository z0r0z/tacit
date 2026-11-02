// The fast bridge's Bitcoin transactions on signet: a note etched, locked twice with the production builder, one lock taken by the
// key path with d_claimer + t, the other refunded by the script path once its timelock has run, and a refund sent too early, which the
// network must refuse. Every output is then read back through the real tacit.validateOutpoint from what the explorers serve.
// Sends real signet transactions from ~/.tacit-validation/signet.json, which only funds two keys derived from it. Each step is kept
// in the state file before it is sent, so a run picks up where the last stopped. Takes about four blocks. Node 22.
//   node tests/fastbridge-signet.mjs

import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { sha256, bytesToHex, hexToBytes, concatBytes } from '../dapp/vendor/tacit-deps.min.js';
import { bigintToBytes32, pedersenCommit, SECP_N } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';
import { deriveLock, claimSecret } from '../dapp/adaptor-btc-lock.js';
import * as X from '../dapp/adaptor-xswap.js';
import { loadTacit } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { bpRangeAggProve } from './bulletproofs.mjs';

const DIR = join(homedir(), '.tacit-validation');
const STATE = process.env.FB_SIGNET_STATE || join(DIR, 'fastbridge-signet-state.json');
const BASES = ['https://mempool.space/signet/api', 'https://blockstream.info/signet/api'];
const FEE_RATE = 2, FUND_USER = 30_000, FUND_LP = 15_000, NOTE = 10_000n, AMOUNT_TAKEN = 4_000n, CSV_REFUND = 2, CSV_TAKEN = 144, DUST = 546;
const POLL_MS = 30_000;

const te = (s) => new TextEncoder().encode(s);
const log = (msg, o = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...o }));
const u32le = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const anchorOf = (txid, vout) => concatBytes(hexToBytes(txid).reverse(), u32le(vout));

const funder = JSON.parse(readFileSync(join(DIR, 'signet.json'), 'utf8'));
const derive = (tag) => sha256(concatBytes(hexToBytes(funder.priv_hex), te(`tacit-fastbridge-rehearsal/${tag}`)));
const walletOf = (priv) => makeBtcWallet({
  priv, hrp: 'tb', fetchUtxos: async () => [], fetchFeeRate: async () => FEE_RATE,
  broadcastTx: async () => { throw new Error('sent through the chain adapter'); },
}).prims;

const tacit = await loadTacit('signet');
const kit = tacitKit(tacit);
const partyOf = (prims) => {
  const builder = makeAdaptorBtcTx({ prims, kit });
  return { prims, tx: builder, chain: makeEsploraBtcChain({ bases: BASES, prims, builder }) };
};
const fund = walletOf(hexToBytes(funder.priv_hex));
assert.equal(fund.wallet.address(), funder.address, 'the funding key is the wallet in the file');
const user = partyOf(walletOf(derive('user'))), lp = partyOf(walletOf(derive('lp')));
const seed = derive('seed');
const own = (p) => p.prims.p2wpkhScript(p.prims.wallet.pub);
const chain = user.chain;

const S = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : { pairs: {} };
const keep = () => writeFileSync(STATE, JSON.stringify(S, null, 1), { mode: 0o600 });
const later = (ms) => new Promise((r) => setTimeout(r, ms));
const confirmed = async (txid) => (await chain.status(txid)).confirmations > 0;
async function untilConfirmed(txid, label) {
  for (;;) {
    let ok = false;
    try { ok = await confirmed(txid); } catch (e) { log('explorer', { error: String(e.message).slice(0, 120) }); }
    if (ok) return;
    log('waiting for a block', { label, txid });
    await later(POLL_MS);
  }
}

// a commit/reveal pair is kept before it is sent, and sent again as it was on a later run
async function once(party, name, build) {
  if (!S.pairs[name]) {
    const p = await build();
    S.pairs[name] = { commitTxid: p.commitTxid, revealTxid: p.revealTxid, commitHex: p.commitHex, revealHex: p.revealHex, commitChange: p.commitTx.outputs[1] ? p.commitTx.outputs[1].value : 0 };
    keep();
  }
  await party.chain.broadcast(S.pairs[name]);
  log('sent', { step: name, commit: S.pairs[name].commitTxid, reveal: S.pairs[name].revealTxid });
  return S.pairs[name];
}

// The two keys' coins, from a plain-sat coin of the funding wallet: a coin of dust size may carry a note.
if (!S.fund) {
  const need = FUND_USER + FUND_LP + 1000;
  const coins = (await makeEsploraBtcChain({ bases: BASES, prims: fund, builder: makeAdaptorBtcTx({ prims: fund, kit }) }).satsUtxos()).filter((c) => c.value >= need).sort((a, b) => a.value - b.value);
  assert.ok(coins.length, 'the funding wallet has a plain coin of that size');
  const coin = coins[0], fee = FEE_RATE * 200, change = coin.value - FUND_USER - FUND_LP - fee;
  const tx = {
    version: 2, locktime: 0, inputs: [{ txid: coin.txid, vout: coin.vout, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: FUND_USER, script: own(user) }, { value: FUND_LP, script: own(lp) }, ...(change >= DUST ? [{ value: change, script: fund.p2wpkhScript(fund.wallet.pub) }] : [])],
  };
  fund.signCommitInputs(tx, [coin], fund.p2wpkhScript(fund.wallet.pub));
  S.fund = { txid: fund.txid(tx), hex: bytesToHex(fund.serializeTx(tx)) };
  keep();
}
await chain.broadcast({ commitHex: S.fund.hex, revealHex: S.fund.hex });
log('funded', { txid: S.fund.txid });
await untilConfirmed(S.fund.txid, 'funding');

// The note: an etch at the user's address, the way the wallet sends one, with a blinding only this run knows.
const rNote = BigInt('0x' + bytesToHex(derive('note-blinding'))) % (SECP_N - 1n) + 1n;
if (!S.etch) {
  const { prims } = user;
  const coin = (await user.chain.satsUtxos())[0];
  const ticker = 'FB' + (await chain.tip()).toString(36).toUpperCase();
  const { proof } = bpRangeAggProve([NOTE], [rNote]);
  const payload = tacit.encodeCEtchPayload({ ticker, decimals: 0, commitment: pedersenCommit(NOTE, rNote).toRawBytes(true), rangeproof: proof, encryptedAmount: new Uint8Array(8) });
  const script = prims.encodeEnvelopeScript(prims.wallet.xonly(), payload);
  const { Q_xonly, parity } = prims.tweakedOutputKey(prims.TAP_NUMS, prims.tapLeafHash(script));
  const commitSpk = prims.p2trScript(Q_xonly);
  const revealVb = 80 + Math.ceil((script.length + 100) / 4), commitValue = DUST + FEE_RATE * revealVb, commitFee = FEE_RATE * 160;
  const commitTx = {
    version: 2, locktime: 0, inputs: [{ txid: coin.txid, vout: coin.vout, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: commitValue, script: commitSpk }, { value: coin.value - commitValue - commitFee, script: own(user) }],
  };
  prims.signCommitInputs(commitTx, [coin], own(user));
  const commitTxid = prims.txid(commitTx);
  const revealTx = { version: 2, locktime: 0, inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: DUST, script: own(user) }] };
  revealTx.inputs[0].witness = prims.signTaprootScriptPathInput(revealTx, [{ value: commitValue, script: commitSpk }], script, prims.controlBlock(prims.TAP_NUMS, parity));
  S.etch = { ticker, commitTxid, revealTxid: prims.txid(revealTx), commitHex: bytesToHex(prims.serializeTx(commitTx)), revealHex: bytesToHex(prims.serializeTx(revealTx)) };
  keep();
}
await chain.broadcast(S.etch);
log('etched', { ticker: S.etch.ticker, reveal: S.etch.revealTxid });
await untilConfirmed(S.etch.revealTxid, 'etch');
const assetHex = tacit.assetIdFor(S.etch.revealTxid, 0);
const asset = typeof assetHex === 'string' ? hexToBytes(assetHex) : assetHex;

// Two locks, each to the provider's key plus its own T. The second is the first one's change note.
const note = { txid: S.etch.revealTxid, vout: 0, value: DUST, amount: NOTE, blinding: rNote };
const lockOf = (n, csvBlocks) => {
  const swapId = X.swapIdOf(n.txid, n.vout), sec = X.deriveSwapSecrets({ seed, swapId });
  const lock = deriveLock({ prims: user.prims, claimerPub: lp.prims.wallet.pub, T: sec.T, lockerXonly: user.prims.wallet.xonly(), csvBlocks });
  return { swapId, sec, lock, hint: X.lockHintScript({ seed, swapId, claimerPub: lp.prims.wallet.pub, csvBlocks, value: n.amount }) };
};
const A = lockOf({ ...note, amount: AMOUNT_TAKEN }, CSV_TAKEN);
const lockA = await once(user, 'lockA', async () => user.tx.lockTransfer({
  asset, notes: [note], lock: A.lock, lockAmount: AMOUNT_TAKEN, rLock: A.sec.rLock, hint: A.hint, satsUtxos: await user.chain.satsUtxos(), feeRate: FEE_RATE,
}));
const noteB = { txid: lockA.revealTxid, vout: 1, value: DUST, amount: NOTE - AMOUNT_TAKEN, blinding: kit.deriveChangeBlinding(user.prims.wallet.priv, anchorOf(note.txid, note.vout), 1) };
const B = lockOf(noteB, CSV_REFUND);
const lockB = await once(user, 'lockB', async () => user.tx.lockTransfer({
  asset, notes: [noteB], lock: B.lock, lockAmount: noteB.amount, rLock: B.sec.rLock, hint: B.hint,
  satsUtxos: [{ txid: lockA.commitTxid, vout: 1, value: lockA.commitChange }], feeRate: FEE_RATE,
}));
await untilConfirmed(lockA.revealTxid, 'lock A');
await untilConfirmed(lockB.revealTxid, 'lock B');

// The hint brings each lock back from the chain alone, as a restored wallet finds it.
for (const [L, pair] of [[A, lockA], [B, lockB]]) {
  const t = await chain.fetchTx(pair.revealTxid);
  const got = X.recoverBtcLock({ prims: user.prims, seed, swapId: L.swapId, lockerXonly: user.prims.wallet.xonly(), outputs: t.vout.map((o) => ({ value: o.value, script: hexToBytes(o.scriptpubkey) })) });
  assert.ok(got, 'the hint is read back from the served transaction');
  assert.equal(got.vout, 0);
}
log('hints read back from the chain');

// Too early: the lock's timelock has not run, so the network refuses the refund. Built from a coin this run has spare, never kept.
const refundB = () => user.chain.satsUtxos().then((coins) => user.tx.refundTransfer({
  asset, lockOut: { txid: lockB.revealTxid, vout: 0, value: DUST }, lock: B.lock, dLocker: user.prims.wallet.priv, amount: noteB.amount, rLock: B.sec.rLock, satsUtxos: coins, feeRate: FEE_RATE,
}));
if (!S.earlyRefused) {
  const { height } = await chain.status(lockB.revealTxid);
  if ((await chain.tip()) + 1 < height + CSV_REFUND) {
    const early = await refundB();
    // the commit is sent on its own: it pays only the wallet and leaves the reveal to be judged by the timelock alone
    const r = await fetch(`${BASES[0]}/tx`, { method: 'POST', body: early.commitHex });
    await r.text();
    const out = await fetch(`${BASES[0]}/tx`, { method: 'POST', body: early.revealHex });
    const text = (await out.text()).slice(0, 200);
    assert.equal(out.ok, false, 'the network must refuse a refund before the timelock');
    assert.match(text, /non-BIP68-final|non-final/i, `refused for the timelock: ${text}`);
    S.earlyRefused = text; keep();
    log('early refund refused', { reason: text });
  } else { S.earlyRefused = 'skipped: the timelock had already run'; keep(); log('early refund not tried', { reason: S.earlyRefused }); }
}

// The provider takes lock A by the key path with d_claimer + t.
const take = await once(lp, 'take', async () => lp.tx.claimTransfer({
  asset, lockOut: { txid: lockA.revealTxid, vout: 0, value: DUST }, lock: A.lock, sk: claimSecret({ dClaimer: lp.prims.wallet.priv, t: A.sec.t, lock: A.lock }),
  amount: AMOUNT_TAKEN, rLock: A.sec.rLock, satsUtxos: await lp.chain.satsUtxos(), feeRate: FEE_RATE,
}));
await untilConfirmed(take.revealTxid, 'take');

// The user refunds lock B once it is old enough: the same builder, now accepted.
const { height: heightB } = await chain.status(lockB.revealTxid);
while ((await chain.tip()) + 1 < heightB + CSV_REFUND) { log('waiting for the timelock', { opensAfter: heightB + CSV_REFUND - 1 }); await later(POLL_MS); }
const refund = await once(user, 'refund', refundB);
await untilConfirmed(refund.revealTxid, 'refund');

// What the explorers serve, through the real validator.
const fetchTx = (id) => chain.fetchTx(id);
const valid = async (txid, vout) => {
  const reasons = new Map();
  const ok = await tacit.validateOutpoint(txid, vout, new Map(), fetchTx, 0, null, null, null, reasons);
  return { ok, reason: reasons.get(`${txid}:${vout}`) };
};
const checks = [['etch', S.etch.revealTxid, 0], ['lock A', lockA.revealTxid, 0], ['change', lockA.revealTxid, 1], ['lock B', lockB.revealTxid, 0], ['take', take.revealTxid, 0], ['refund', refund.revealTxid, 0]];
for (const [label, txid, vout] of checks) {
  const r = await valid(txid, vout);
  log('validated', { label, txid, vout, ...r });
  assert.equal(r.ok, true, `${label}: ${r.reason}`);
}
assert.equal(await chain.outspend(lockA.revealTxid, 0), take.revealTxid, 'lock A was spent by the take');
assert.equal(await chain.outspend(lockB.revealTxid, 0), refund.revealTxid, 'lock B was spent by the refund');
const takeTx = await chain.fetchTx(take.revealTxid), refundTx = await chain.fetchTx(refund.revealTxid);
assert.equal(takeTx.vin[1].witness.length, 1, 'the take is a key-path spend');
assert.equal(refundTx.vin[1].witness.length, 3, 'the refund is a script-path spend');
assert.equal(refundTx.vin[1].sequence, CSV_REFUND, 'the refund carries the timelock');
log('all good', { lockA: lockA.revealTxid, lockB: lockB.revealTxid, take: take.revealTxid, refund: refund.revealTxid, earlyRefund: S.earlyRefused });
