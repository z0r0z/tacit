#!/usr/bin/env node
// dapp/crossout-ux.js: the cross-out bridge (Ethereum -> Bitcoin) state machine. Drives a full
// settled -> covered -> mint-signed -> mint-submitted -> minted cycle against real cryptography (real
// secp256k1 signing via dapp/bitcoin-taproot-wallet.js, real envelope construction via
// dapp/crossout-mint-reveal.js) with the network layer (crossOut's relay dispatch, eth-state coverage,
// chain broadcast/UTXO selection) stubbed by an in-memory "world" the test controls.
//
// Run: node tests/crossout-ux.test.mjs
import assert from 'node:assert';
import { hmac } from '../node_modules/@noble/hashes/hmac.js';
import { sha256 as nobleSha256 } from '../node_modules/@noble/hashes/sha2.js';
import { keccak_256 } from '../node_modules/@noble/hashes/sha3.js';
import { makeConfidentialPool } from '../dapp/confidential-pool.js';
import { makeConfidentialEvmLog } from '../dapp/confidential-evm-log.js';

// dapp/bitcoin-taproot-wallet.js (imported transitively by crossout-ux.js) pulls in the vendor bundle
// (poseidon et al.), which expects a browser-like global scope at import time -- same shim
// burndep-ux.test.mjs uses ahead of its own tacit.js import.
const realFetch = globalThis.fetch, realST = globalThis.setTimeout, realCT = globalThis.clearTimeout;
await import('../scratchpad/domshim2.mjs');
globalThis.setTimeout = realST; globalThis.clearTimeout = realCT;

// dapp/bitcoin-taproot-wallet.js imports secp from the vendor bundle, not node_modules directly (all
// third-party JS is vendored -- see dapp/tacit.js's own header comment) -- importing that same instance
// here so the hmacSha256Sync setup below actually lands on the object its signing calls read from. Must be
// dynamic (after the shim above), same reason crossout-ux.js itself is imported dynamically below.
const { secp } = await import('../dapp/vendor/tacit-deps.min.js');
secp.etc.hmacSha256Sync = (k, ...m) => hmac(nobleSha256, k, secp.etc.concatBytes(...m));
const { makeBtcWallet } = await import('../dapp/bitcoin-taproot-wallet.js');
// The self-bridge destination is always this wallet's own Bitcoin key (crossout-ux.js's own freshPrims) --
// computed once here so the recovery tests can assert against it without re-deriving it inline each time.
const destXonlyOf = (priv) => bytesToHex(makeBtcWallet({ priv, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 1 }).wallet.xonly());

const { makeCrossoutUx, CROSSOUT_BETA_CAP_RAW, CROSSOUT_TETH_CAP_RAW, CROSSOUT_TETH_MIN_RAW } = await import('../dapp/crossout-ux.js');
globalThis.fetch = realFetch;

const pool = makeConfidentialPool({ secp, keccak256: keccak_256, sha256: nobleSha256 });
const evmLog = makeConfidentialEvmLog({ keccak256: keccak_256 });

let n = 0, failures = 0;
const ok = (c, m) => { if (c) { console.log('  ok -', m); n++; } else { console.error('  FAIL -', m); failures++; } };

const stripHex = (h) => String(h).replace(/^0x/, '');
const withHex = (h) => '0x' + stripHex(h);
const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const hexToBytes = (h) => { const s = stripHex(h); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const topicCrossOutRecorded = '0x' + bytesToHex(keccak_256(new TextEncoder().encode('CrossOutRecorded(bytes32,uint16,bytes32,bytes32,bytes32)')));
// Builds a raw {topics, data} log exactly as ConfidentialPool would emit CrossOutRecorded, so
// evmLog.decodeLog (the real decoder, not a stand-in) is what recoverFromEthTx actually exercises.
function buildCrossOutRecordedLog({ claimId, destChain, destCommitment, nullifier, assetId }) {
  const word32 = (n) => { const b = new Uint8Array(32); b[31] = Number(n); return b; };
  const data = new Uint8Array(128);
  data.set(word32(destChain), 0);
  data.set(hexToBytes(destCommitment), 32);
  data.set(hexToBytes(nullifier), 64);
  data.set(hexToBytes(assetId), 96);
  return { topics: [topicCrossOutRecorded, claimId], data: '0x' + bytesToHex(data) };
}
// The exact HMAC-bound blinding crossOut() derives by default (confidential-pool-ux.js) -- reproduced here
// so the "happy path" recovery test's fixture is internally consistent with what recoverFromEthTx recomputes,
// and so a real start() and a real recoverFromEthTx over the same (walletPriv, nullifier) can be asserted equal.
function deriveCrossoutBlinding(walletPriv, nullifierHex) {
  const domain = new TextEncoder().encode('tacit-crossout-blinding-v1');
  const nullifierBytes = hexToBytes(nullifierHex);
  const msg = new Uint8Array(domain.length + nullifierBytes.length);
  msg.set(domain); msg.set(nullifierBytes, domain.length);
  const raw = hmac(nobleSha256, walletPriv, msg);
  let b = 0n; for (const x of raw) b = (b << 8n) | BigInt(x);
  b %= secp.CURVE.n;
  return b === 0n ? 1n : b;
}

const POOL_ADDR = '0x000000000Ed1eabD231Be41d93b719056F7febFC';
const ASSET = withHex('a5'.repeat(32));
const WALLET_PRIV = new Uint8Array(32).fill(0x33);
const WALLET_PUB = secp.getPublicKey(WALLET_PRIV, true);
const NOTE = { nullifier: withHex('7e'.repeat(32)), value: 900_000n, blinding: 0x1234n, asset: ASSET, confirmed: true };
const FUND_TXID = '61'.repeat(32);
const CLAIM_ID = withHex('c1'.repeat(32));
const CX = withHex('c2'.repeat(32));
const CY = withHex('c3'.repeat(32));

// ---- an in-memory "world": chain state + worker endpoints, driven by this test ----
function makeWorld() {
  const chainTxs = new Map(); // txid(bare) -> {status:{confirmed}}
  const ethReceipts = new Map(); // txHash(display) -> receipt
  const broadcasts = [];
  let ethCovered = false;
  let ethHead = 26_147_613, bestBlock = 26_147_224, confirmedBlock = 26_144_163;
  let status = { attestedHeight: 970373, tipHeight: 970373 };
  let statusDown = false, utxos = [{ txid: FUND_TXID, vout: 0, value: 50_000 }], unconfirmed = false;
  const crossOutCalls = [];
  let chainLogs = [], crossOutError = null, creditDown = false, credit = { decided: true, minted: true };
  const droppedTxs = new Set();
  let broadcastError = null;
  let lastCreditQuery = null;
  let claimIdVerified = true;
  let claimIdNote = 'corroborated against CrossOutRecorded';

  async function rpc(method, params) {
    if (method === 'eth_getTransactionReceipt') return ethReceipts.get(stripHex(params[0]).toLowerCase()) || null;
    if (method === 'eth_blockNumber') return '0x' + ethHead.toString(16);
    if (method === 'eth_getLogs') {
      const f = params[0], from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
      return chainLogs.filter((l) => { const b = Number(BigInt(l.blockNumber)); return b >= from && b <= to && (!f.address || f.address === POOL_ADDR); });
    }
    throw new Error(`world: unhandled rpc ${method}`);
  }

  const fetchImpl = async (url) => {
    const u = new URL(url, 'http://x');
    const p = u.pathname;
    if (p.endsWith('/reflection/eth-state/covers')) {
      if (statusDown) return { ok: false, json: async () => ({ error: 'too many requests' }) };
      return { ok: true, json: async () => ({ covered: ethCovered, block: Number(u.searchParams.get('block')), bestBlock, confirmedBlock }) };
    }
    if (p.endsWith('/reflection/status')) {
      if (statusDown) return { ok: false, json: async () => ({ error: 'down' }) };
      return { ok: true, json: async () => ({ network: 'mainnet', ...status }) };
    }
    if (p.endsWith('/crossout/minted')) {
      if (creditDown) return { ok: false, json: async () => ({ error: 'down' }) };
      lastCreditQuery = Object.fromEntries(u.searchParams);
      return { ok: true, json: async () => ({ network: 'mainnet', decided: credit.decided, minted: credit.minted, status: credit.status || null, mintedTxid: credit.mintedTxid || null }) };
    }
    const dropped = p.match(/\/chain\/tx\/([0-9a-f]+)$/) && droppedTxs.has(p.match(/\/chain\/tx\/([0-9a-f]+)$/)[1]);
    if (dropped) return { ok: false, status: 404, json: async () => { throw new Error('Unexpected token T in JSON'); } };           // an explorer's plain-text "Transaction not found"
    const chainMatch = p.match(/\/chain\/tx\/([0-9a-f]+)$/);
    if (chainMatch) {
      const tx = chainTxs.get(chainMatch[1]);
      if (!tx) return { ok: true, json: async () => ({ error: 'not-found' }) };
      return { ok: true, json: async () => tx };
    }
    throw new Error(`world: unhandled fetch ${p}`);
  };

  const chain = {
    getUtxos: async () => utxos.map((x) => ({ ...x, status: { confirmed: !unconfirmed } })),
    pickSafeCommitSats: async (us) => us,
    broadcastWithRetry: async (hex) => { if (broadcastError) throw broadcastError; broadcasts.push(hex); return { txid: 'stub' }; },
    getFeeRate: async () => 3,
  };

  async function crossOut(args) {
    const { notes, amount, destOwner, fee = 0n } = args;
    crossOutCalls.push(args);
    if (crossOutError) throw crossOutError;
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(amount + fee, BigInt(notes[0].value));
    return {
      txHash: withHex('aa'.repeat(32)),
      crossOuts: [{ claimId: CLAIM_ID, cx: CX, cy: CY, owner: destOwner, destCommitment: withHex('dd'.repeat(32)) }],
      ethBlock: 12345,
      claimIdVerified, claimIdNote,
    };
  }

  return {
    fetchImpl, chain, crossOut, rpc,
    setEthCovered: (v) => { ethCovered = v; },
    setCredit: (v) => { credit = v; }, setCreditDown: (v) => { creditDown = v; }, creditQuery: () => lastCreditQuery,
    dropTx: (txid) => droppedTxs.add(stripHex(txid)), restoreTx: (txid) => droppedTxs.delete(stripHex(txid)), setBroadcastError: (e) => { broadcastError = e; },
    crossOutCalls, setLogs: (v) => { chainLogs = v; }, setCrossOutError: (e) => { crossOutError = e; },
    setStatus: (v) => { status = v; }, setStatusDown: (v) => { statusDown = v; }, setUtxos: (v) => { utxos = v; }, setUnconfirmed: (v) => { unconfirmed = v; },
    setCoverage: (o) => { if (o.ethHead != null) ethHead = o.ethHead; if (o.bestBlock !== undefined) bestBlock = o.bestBlock; if (o.confirmedBlock !== undefined) confirmedBlock = o.confirmedBlock; },
    setClaimIdVerified: (v, note) => { claimIdVerified = v; claimIdNote = note || claimIdNote; },
    mineRevealTxid: (txid) => chainTxs.set(stripHex(txid), { status: { confirmed: true } }),
    unconfirmTxid: (txid) => chainTxs.set(stripHex(txid), { status: { confirmed: false } }),
    setEthReceipt: (txHash, receipt) => ethReceipts.set(stripHex(txHash).toLowerCase(), receipt),
    broadcasts,
  };
}

function makeUx(world, extra = {}) {
  return makeCrossoutUx({
    network: 'mainnet', hrp: 'bc', workerBase: 'http://worker', fetchImpl: world.fetchImpl,
    storage: (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, v), removeItem: (k) => m.delete(k), get length() { return m.size; }, key: (i) => Array.from(m.keys())[i] || null }; })(),
    secp, hmac, sha256: nobleSha256, crossOut: world.crossOut, pool, rpc: world.rpc, evmLog, tacAssetId: ASSET, chain: world.chain, ...extra,
  });
}

// ---- eligibility ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  const [eligible] = ux.eligibleNotes([NOTE]);
  ok(eligible.eligible === true, 'a confirmed, under-cap TAC note is eligible');

  const [wrongAsset] = ux.eligibleNotes([{ ...NOTE, asset: withHex('ff'.repeat(32)) }]);
  ok(wrongAsset.eligible === false && wrongAsset.reason === 'not TAC', 'a non-TAC note is ineligible');

  const [overCap] = ux.eligibleNotes([{ ...NOTE, value: CROSSOUT_BETA_CAP_RAW + 1n }]);
  ok(overCap.eligible === false && /1,000 TAC beta limit/.test(overCap.reason), 'a note over the 1,000 TAC cap is ineligible, with the cap named in the reason');

  const [atCap] = ux.eligibleNotes([{ ...NOTE, value: CROSSOUT_BETA_CAP_RAW }]);
  ok(atCap.eligible === true, 'a note exactly at the cap is eligible (cap is inclusive)');

  const [unconfirmed] = ux.eligibleNotes([{ ...NOTE, confirmed: false }]);
  ok(unconfirmed.eligible === false && unconfirmed.reason === 'unconfirmed', 'an unconfirmed note is ineligible');
}

// ---- start() rejects over-cap before ever calling crossOut ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  let threw = false;
  try { await ux.start({ note: { ...NOTE, value: CROSSOUT_BETA_CAP_RAW + 1n }, walletPriv: WALLET_PRIV }); }
  catch (e) { threw = /beta cap/.test(e.message); }
  ok(threw, 'start() refuses a note over the beta cap without settling anything');
}

// ---- full happy path: settled -> covered -> mint-signed -> mint-submitted -> minted ----
{
  const world = makeWorld();
  const ux = makeUx(world);

  const rec0 = await ux.start({ note: NOTE, walletPriv: WALLET_PRIV });
  ok(rec0.stage === 'settled', 'start() produces a settled record (the ETH-side settle is atomic — no separate signed-but-unsent stage)');
  ok(rec0.settle.claimId === CLAIM_ID && rec0.settle.claimIdVerified === true, 'the record carries the corroborated claimId');
  ok(/^[0-9a-f]{64}$/.test(stripHex(rec0.destXonly)), 'a self-bridge destination x-only key was derived');

  let threwDup = false;
  try { await ux.start({ note: NOTE, walletPriv: WALLET_PRIV }); } catch { threwDup = true; }
  ok(threwDup, 'start() refuses a second bridge for the same note (already reserved)');

  const [reserved] = ux.eligibleNotes([NOTE]);
  ok(reserved.eligible === false && reserved.reason === 'already bridging', 'the note now shows as already bridging in eligibleNotes');

  // not yet covered — advance is a resumable no-op, not an error
  const stillSettled = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(stillSettled.stage === 'settled', 'advance() before eth-state coverage stays at settled rather than erroring');

  world.setEthCovered(true);
  const covered = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(covered.stage === 'covered', 'advance() moves to covered once /reflection/eth-state/covers reports true');

  let threwNoKey = false;
  try { await ux.advance(WALLET_PUB, NOTE.nullifier); } catch (e) { threwNoKey = /wallet key/.test(e.message); }
  ok(threwNoKey, 'covered -> mint-signed refuses without the wallet key');

  const signed = await ux.advance(WALLET_PUB, NOTE.nullifier, { walletPriv: WALLET_PRIV });
  ok(signed.stage === 'mint-signed', 'advance() with the key builds and signs the Bitcoin-side commit/reveal');
  ok(/^[0-9a-f]+$/.test(signed.mint.commitHex) && /^[0-9a-f]+$/.test(signed.mint.revealHex), 'commit and reveal hex were produced');
  ok(signed.mint.revealHex.includes('225120' + stripHex(signed.destXonly)), "the reveal's vout 0 really does pay P2TR(destXonly)");

  const submitted = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(submitted.stage === 'mint-submitted', 'advance() broadcasts commit then reveal');
  ok(world.broadcasts.length === 2 && world.broadcasts[0] === signed.mint.commitHex && world.broadcasts[1] === signed.mint.revealHex, 'commit was broadcast before reveal, in order');

  const stillSubmitted = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(stillSubmitted.stage === 'mint-submitted', 'advance() before the reveal confirms stays at mint-submitted');

  world.mineRevealTxid(submitted.mint.revealTxid);
  const confirmed = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(confirmed.stage === 'mint-confirmed', 'a reveal confirmed on Bitcoin is not yet an arrived bridge: it waits for the note to be credited');
  const minted = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(minted.stage === 'minted', 'advance() reaches minted once the worker credits the note');
  { const q = world.creditQuery(); ok(q.asset === stripHex(ASSET) && q.claim === stripHex(CLAIM_ID) && q.txid === minted.mint.revealTxid, 'the credit is asked for this asset, this claim and this reveal'); }

  const final = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(final.stage === 'minted', 'advance() on a minted record is a no-op, not an error');
}

// ---- an unverified claimId blocks progress with a clear, visible error rather than silently proceeding ----
{
  const world = makeWorld();
  world.setClaimIdVerified(false, 'no matching CrossOutRecorded event for every destCommitment');
  const ux = makeUx(world);
  await ux.start({ note: NOTE, walletPriv: WALLET_PRIV });
  world.setEthCovered(true);

  let threw = false;
  try { await ux.advance(WALLET_PUB, NOTE.nullifier); }
  catch (e) { threw = /claimId not corroborated/.test(e.message); }
  ok(threw, 'advance() refuses to move past settled when the claimId was never corroborated');

  const list = ux.list(WALLET_PUB);
  const rec = list.find((r) => r.id === NOTE.nullifier);
  ok(rec.stage === 'settled' && rec.lastError && /claimId not corroborated/.test(rec.lastError.message), 'the record is journalled with the error visible, not silently stuck');
}

// ---- resumeAll drives an in-flight record forward without the key, stopping where the key is required ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  await ux.start({ note: NOTE, walletPriv: WALLET_PRIV });
  world.setEthCovered(true);

  const results = await ux.resumeAll(WALLET_PUB);
  const rec = ux.list(WALLET_PUB).find((r) => r.id === NOTE.nullifier);
  ok(rec.stage === 'covered', 'resumeAll() without a key advances as far as settled -> covered');
  ok(results.length === 1 && !results[0].error, 'resumeAll() reports the record it advanced without error');
}

// ---- abandon removes a record from the journal ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  await ux.start({ note: NOTE, walletPriv: WALLET_PRIV });
  ux.abandon(WALLET_PUB, NOTE.nullifier);
  ok(ux.list(WALLET_PUB).length === 0, 'abandon() removes the record');
  ok(ux.isReserved(NOTE.nullifier) === false, 'an abandoned note is no longer reserved');
}

// ---- recoverFromEthTx: rebuilds an identical record from just the settle tx hash + amount, no journal ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  const destXonly = destXonlyOf(WALLET_PRIV);
  const rDest = deriveCrossoutBlinding(WALLET_PRIV, NOTE.nullifier);
  const { cx, cy } = pool.commitXY(NOTE.value, rDest);
  const destCommitment = pool.btcNoteLeaf(ASSET, cx, cy, withHex(destXonly));
  const settleTxHash = withHex('ee'.repeat(32));
  world.setEthReceipt(settleTxHash, {
    blockNumber: '0x' + (77777).toString(16),
    logs: [buildCrossOutRecordedLog({ claimId: CLAIM_ID, destChain: 1, destCommitment, nullifier: NOTE.nullifier, assetId: ASSET })],
  });

  const rec = await ux.recoverFromEthTx(settleTxHash, WALLET_PRIV, { amount: NOTE.value });
  ok(rec.stage === 'settled', 'recoverFromEthTx() rebuilds a settled record from chain data alone');
  ok(rec.settle.claimId.toLowerCase() === CLAIM_ID.toLowerCase(), 'the claimId comes straight from the event, not guessed');
  ok(rec.settle.cx.toLowerCase() === cx.toLowerCase() && rec.settle.cy.toLowerCase() === cy.toLowerCase(), 'cx/cy are correctly re-derived from (walletPriv, nullifier, amount)');
  ok(rec.settle.ethBlock === 77777, 'the settle block number is read from the receipt');
  ok(rec.destXonly.toLowerCase() === destXonly.toLowerCase(), 'the self-bridge destination key matches, needing no stored state at all');
  ok(ux.isReserved(NOTE.nullifier) === true, 'the recovered record shows up as reserved, same as a freshly-started one');

  // Advancing it forward from here uses the exact same path a normal record would.
  world.setEthCovered(true);
  const covered = await ux.advance(WALLET_PUB, NOTE.nullifier);
  ok(covered.stage === 'covered', 'a recovered record advances normally afterward');
}

// ---- recoverFromEthTx refuses rather than misfiling on any wrong input ----
{
  const world = makeWorld();
  const ux = makeUx(world);
  const destXonly = destXonlyOf(WALLET_PRIV);
  const rDest = deriveCrossoutBlinding(WALLET_PRIV, NOTE.nullifier);
  const { cx, cy } = pool.commitXY(NOTE.value, rDest);
  const destCommitment = pool.btcNoteLeaf(ASSET, cx, cy, withHex(destXonly));
  const settleTxHash = withHex('ef'.repeat(32));
  world.setEthReceipt(settleTxHash, {
    blockNumber: '0x1',
    logs: [buildCrossOutRecordedLog({ claimId: CLAIM_ID, destChain: 1, destCommitment, nullifier: NOTE.nullifier, assetId: ASSET })],
  });

  let threwWrongAmount = false;
  try { await ux.recoverFromEthTx(settleTxHash, WALLET_PRIV, { amount: NOTE.value + 1n }); }
  catch (e) { threwWrongAmount = /does not match/.test(e.message); }
  ok(threwWrongAmount, 'a wrong amount is caught by the destCommitment check, not silently written');

  let threwNoReceipt = false;
  try { await ux.recoverFromEthTx(withHex('ff'.repeat(32)), WALLET_PRIV, { amount: NOTE.value }); }
  catch (e) { threwNoReceipt = /no receipt/.test(e.message); }
  ok(threwNoReceipt, 'an unmined or wrong-network tx hash is refused up front');

  let threwNoEvent = false;
  const emptyTxHash = withHex('f0'.repeat(32));
  world.setEthReceipt(emptyTxHash, { blockNumber: '0x1', logs: [] });
  try { await ux.recoverFromEthTx(emptyTxHash, WALLET_PRIV, { amount: NOTE.value }); }
  catch (e) { threwNoEvent = /no CrossOutRecorded/.test(e.message); }
  ok(threwNoEvent, 'a tx with no CrossOutRecorded event is refused rather than guessed at');
}

// ---- more than one asset: tETH beside TAC, each with its own cap and minimum ----
const TETH = withHex('3c'.repeat(32));
const MULTI = { assets: [{ assetId: ASSET, ticker: 'TAC', capRaw: CROSSOUT_BETA_CAP_RAW }, { assetId: TETH, ticker: 'tETH', capRaw: CROSSOUT_TETH_CAP_RAW, minRaw: CROSSOUT_TETH_MIN_RAW }] };
const TNOTE = { nullifier: withHex('7f'.repeat(32)), value: 400_000n, blinding: 0x4321n, asset: TETH, confirmed: true };
{
  const world = makeWorld();
  const ux = makeUx(world, MULTI);
  const [t, tac, other, over, under, atCap, atMin] = ux.eligibleNotes([TNOTE, NOTE, { ...TNOTE, asset: withHex('ff'.repeat(32)) },
    { ...TNOTE, value: CROSSOUT_TETH_CAP_RAW + 1n }, { ...TNOTE, value: CROSSOUT_TETH_MIN_RAW - 1n }, { ...TNOTE, value: CROSSOUT_TETH_CAP_RAW }, { ...TNOTE, value: CROSSOUT_TETH_MIN_RAW }]);
  ok(t.eligible && tac.eligible, 'a tETH note and a TAC note are both eligible when both are configured');
  ok(!other.eligible && other.reason === 'not an asset this bridge takes', 'an asset that is neither is refused, without naming one asset when two are configured');
  ok(!over.eligible && /over the 0\.005 tETH beta limit/.test(over.reason), 'a tETH note over its own cap is refused, the cap named in tETH');
  ok(!under.eligible && /under the 0\.001 tETH minimum/.test(under.reason), 'a tETH note under its minimum is refused');
  ok(atCap.eligible && atMin.eligible, 'both limits are inclusive');
  ok(ux.assets.length === 2 && ux.assetOf(TETH).ticker === 'tETH', 'the configured assets are readable');
  // TAC's cap does not bleed into tETH and the reverse: a TAC note far over tETH's cap is fine.
  ok(ux.eligibleNotes([{ ...NOTE, value: CROSSOUT_TETH_CAP_RAW * 100n }])[0].eligible, 'a TAC note far over tETH\'s cap is still eligible as TAC');
}

// ---- start() with a relay fee: the Bitcoin note is the note less the fee, and the record says both ----
{
  const world = makeWorld();
  const ux = makeUx(world, MULTI);
  const rec = await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n });
  const call = world.crossOutCalls[0];
  ok(call.amount === 390_000n && call.fee === 10_000n, 'crossOut is asked to burn the note as amount + fee, nothing left over');
  ok(call.destChain === 1 && /^[0-9a-f]{64}$/.test(stripHex(call.destOwner)), 'the destination is this key\'s own Bitcoin key');
  ok(rec.source.assetId.toLowerCase() === TETH.toLowerCase() && rec.source.ticker === 'tETH', 'the record names the asset it carries');
  ok(rec.source.value === 400_000n && rec.source.amount === 390_000n && rec.source.fee === 10_000n, 'the record keeps the note, what arrives, and the fee, as bigints');
  const reread = ux.list(WALLET_PUB)[0];
  ok(typeof reread.source.fee === 'bigint' && typeof reread.source.amount === 'bigint', 'fee and amount survive the journal as bigints');

  world.setEthCovered(true);
  const covered = await ux.advance(WALLET_PUB, TNOTE.nullifier);
  const signed = await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV });
  ok(covered.stage === 'covered' && signed.stage === 'mint-signed', 'a tETH record walks the same stages');
  ok(stripHex(signed.mint.revealHex).includes('3c'.repeat(32)), 'the signed reveal carries the tETH asset id, not TAC\'s');
  ok(!stripHex(signed.mint.revealHex).includes('a5'.repeat(32)), 'and not the TAC asset id');
}

// ---- start() refuses what it must before settling anything ----
{
  const world = makeWorld();
  const ux = makeUx(world, MULTI);
  const refuses = async (args, re, what) => { let m = null; try { await ux.start({ walletPriv: WALLET_PRIV, ...args }); } catch (e) { m = e.message; } ok(m && re.test(m) && world.crossOutCalls.length === 0, what); };
  await refuses({ note: { ...TNOTE, value: CROSSOUT_TETH_CAP_RAW + 1n } }, /beta cap/, 'start() refuses a tETH note over its cap without calling crossOut');
  await refuses({ note: { ...TNOTE, value: CROSSOUT_TETH_MIN_RAW - 1n } }, /minimum/, 'start() refuses one under its minimum');
  await refuses({ note: { ...TNOTE, asset: withHex('ff'.repeat(32)) } }, /cannot be bridged/, 'start() refuses an unknown asset');
  await refuses({ note: TNOTE, fee: TNOTE.value }, /relay fee must be under/, 'start() refuses a fee that takes the whole note');
  await refuses({ note: TNOTE, fee: -1n }, /relay fee must be under/, 'and a negative one');
}

// ---- self-settle and wait options reach the pool's crossOut ----
{
  const world = makeWorld();
  const ux = makeUx(world, MULTI);
  const selfSettle = async () => ({ txHash: '0x1' }), waitOpts = { onProgress() {} };
  await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n, selfSettle, waitOpts });
  const c = world.crossOutCalls[0];
  ok(c.selfSettle === selfSettle && c.waitOpts === waitOpts && c.fee === 0n, 'selfSettle and waitOpts are handed to crossOut unchanged');
}

// ---- preflight: read before anything is burned ----
{
  const world = makeWorld();
  const ux = makeUx(world, MULTI);
  const pf = await ux.preflight({ walletPriv: WALLET_PRIV });
  ok(pf.ok && pf.problems.length === 0 && pf.warnings.length === 0, 'with sats free and the proof keeping up, preflight is clean');
  ok(pf.haveSats === 50_000 && pf.needSats > 0 && pf.needSats < 50_000 && pf.feeRate === 3, 'it reports the sats on hand against what one mint needs');
  { const fees = 180 * 6 + 154 * 6, dust = pf.needSats - fees; ok(dust >= 294 && dust <= 546, 'what it asks for is both fees at twice today\'s rate (3 sat/vB) plus the output\'s dust'); }
  ok(pf.reflection.lagBlocks === 0 && pf.coverage.behindBlocks === 26_147_613 - 26_147_224, 'it reads how far the proof and the Ethereum view are behind');
  ok(/^bc1q/.test(pf.address), 'and names the address that pays');

  world.setUtxos([{ txid: FUND_TXID, vout: 0, value: 400 }]);
  const poor = await ux.preflight({ walletPriv: WALLET_PRIV });
  ok(!poor.ok && poor.problems.some((p) => p.name === 'funding') && /400 sats/.test(poor.problems[0].detail), 'too few sats is a problem, naming what is there');
  world.setUtxos([]);
  const none = await ux.preflight({ walletPriv: WALLET_PRIV });
  ok(!none.ok && none.problems[0].name === 'funding' && /no free coin/.test(none.problems[0].detail), 'no coin at all is a problem');
  world.setUtxos([{ txid: FUND_TXID, vout: 0, value: 50_000 }]); world.setUnconfirmed(true);
  const unc = await ux.preflight({ walletPriv: WALLET_PRIV });
  ok(!unc.ok && unc.problems[0].name === 'funding-unconfirmed', 'a coin that is not confirmed yet is a problem');
  world.setUnconfirmed(false);

  world.setStatusDown(true);
  const down = await ux.preflight({ walletPriv: WALLET_PRIV });
  ok(!down.ok && down.problems.some((p) => p.name === 'proof-unreadable'), 'an unreadable proof status stops a bridge: the gate that protects the mint could not be asked either');
  world.setStatusDown(false);

  world.setStatus({ attestedHeight: 970000, tipHeight: 970373 });
  world.setCoverage({ bestBlock: 26_140_000, confirmedBlock: 26_139_000 });
  const slow = await ux.preflight({ walletPriv: WALLET_PRIV });
  ok(slow.ok && slow.warnings.map((w) => w.name).sort().join() === 'coverage-behind,reflection-behind', 'a proof far behind is a warning, not a stop: nothing is lost by waiting');
  world.setStatus({ attestedHeight: 970373, tipHeight: 970373 });
  world.setCoverage({ bestBlock: null, confirmedBlock: null });
  const noView = await ux.preflight({ walletPriv: WALLET_PRIV });
  ok(noView.ok && noView.warnings.some((w) => w.name === 'coverage-behind' && /no view/.test(w.detail)), 'no Ethereum view yet is a warning');
}

// ---- preflight counts the bridges that have yet to take a coin of their own ----
{
  const world = makeWorld();
  const ux = makeUx(world, MULTI);
  await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
  const one = await ux.preflight({ walletPriv: WALLET_PRIV });
  ok(!one.ok && one.pending === 1 && one.problems[0].name === 'funding' && /no free coin/.test(one.problems[0].detail), 'a second bridge is not passed on the coin the first one signs its mint from');
  world.setUtxos([{ txid: FUND_TXID, vout: 0, value: 50_000 }, { txid: FUND_TXID, vout: 1, value: 40_000 }]);
  const two = await ux.preflight({ walletPriv: WALLET_PRIV });
  ok(two.ok && two.pending === 1 && two.haveSats === 40_000, 'with a second coin it passes, checked against that coin');
  world.setUtxos([{ txid: FUND_TXID, vout: 0, value: 50_000 }]);
  const again = await ux.preflight({ walletPriv: WALLET_PRIV, exclude: [TNOTE.nullifier] });
  ok(again.ok && again.pending === 0 && again.haveSats === 50_000, 'a bridge being sent again is not counted against itself');
}

// ---- the unattended mint waits out a fee spike, and a signed mint Bitcoin never took can be signed again ----
{
  const world = makeWorld();
  let rate = 400;
  world.chain.getFeeRate = async () => rate;
  world.setUtxos([{ txid: FUND_TXID, vout: 0, value: 200_000 }]);
  const ux = makeUx(world, MULTI);
  await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
  world.setEthCovered(true);
  await ux.advance(WALLET_PUB, TNOTE.nullifier);
  let m = null; try { await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV }); } catch (e) { m = e.message; }
  ok(/fees are high right now \(400 sat\/vB, about [\d,]+ sats for this step\)/.test(m || '') && ux.list(WALLET_PUB)[0].stage === 'covered' && world.broadcasts.length === 0, 'above the fee ceiling the Bitcoin step waits: nothing is signed or sent, and the record says why');
  const forced = await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV, allowHighFee: true });
  ok(forced.stage === 'mint-signed', 'sent anyway when the holder says so');
  rate = 20;

  // resign: only a signed mint whose first transaction Bitcoin does not have.
  let r1 = null; try { await ux.resign(WALLET_PUB, TNOTE.nullifier); } catch (e) { r1 = e.message; }
  ok(r1 === null && ux.list(WALLET_PUB)[0].stage === 'covered' && !ux.list(WALLET_PUB)[0].mint, 'a signed mint whose commit Bitcoin does not have goes back to covered, its signatures dropped');
  const again = await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV });
  ok(again.stage === 'mint-signed', 'and is signed again from a free coin');
  world.mineRevealTxid(again.mint.commitTxid);
  let r2 = null; try { await ux.resign(WALLET_PUB, TNOTE.nullifier); } catch (e) { r2 = e.message; }
  ok(/already on Bitcoin/.test(r2 || '') && ux.list(WALLET_PUB)[0].stage === 'mint-signed', 'not once its commit is on Bitcoin');
  let r3 = null; try { await ux.resign(WALLET_PUB, 'nope'); } catch (e) { r3 = e.message; }
  ok(/no bridge record/.test(r3 || ''), 'and not for a record that is not there');
}
{
  // A check that could not be made is not read as "absent".
  const world = makeWorld();
  const baseFetch = world.fetchImpl;
  world.fetchImpl = async (url) => (String(url).includes('/chain/tx/') ? { ok: false, status: 503, json: async () => ({}) } : baseFetch(url));
  const ux = makeUx(world, MULTI);
  await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
  world.setEthCovered(true);
  await ux.advance(WALLET_PUB, TNOTE.nullifier);
  await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV });
  let m = null; try { await ux.resign(WALLET_PUB, TNOTE.nullifier); } catch (e) { m = e.message; }
  ok(/could not check/.test(m || '') && ux.list(WALLET_PUB)[0].stage === 'mint-signed', 'an outage while checking leaves the signed mint alone');
  const w404 = makeWorld();
  const b2 = w404.fetchImpl;
  w404.fetchImpl = async (url) => (String(url).includes('/chain/tx/') ? { ok: false, status: 404, json: async () => { throw new Error('not json'); } } : b2(url));
  const ux3 = makeUx(w404, MULTI);
  await ux3.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
  w404.setEthCovered(true);
  await ux3.advance(WALLET_PUB, TNOTE.nullifier);
  await ux3.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV });
  await ux3.resign(WALLET_PUB, TNOTE.nullifier);
  ok(ux3.list(WALLET_PUB)[0].stage === 'covered', 'a 404 from the chain proxy is an explicit absence');
}

// ---- a confirmed reveal is not an arrival until the worker credits it ----
{
  const world = makeWorld(); const ux = makeUx(world, MULTI);
  await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
  world.setEthCovered(true);
  await ux.advance(WALLET_PUB, TNOTE.nullifier);
  const signed = await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV });
  await ux.advance(WALLET_PUB, TNOTE.nullifier);
  world.mineRevealTxid(signed.mint.revealTxid);
  ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'mint-confirmed', 'confirmed on Bitcoin');
  world.setCredit({ decided: false, minted: false });
  ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'mint-confirmed', 'undecided: it waits');
  world.setCreditDown(true);
  ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'mint-confirmed', 'an unreadable answer waits too, and is no error');
  world.setCreditDown(false);
  world.setCredit({ decided: true, minted: false, status: 'rejected' });
  const rej = await ux.advance(WALLET_PUB, TNOTE.nullifier);
  ok(rej.stage === 'mint-rejected' && rej.rejectedStatus === 'rejected', 'decided and not credited is a refusal, kept visible on the record');
  ok(ux.isReserved(TNOTE.nullifier), 'a refused bridge still holds its record');
  world.setCredit({ decided: true, minted: true });
  ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'minted', 'and flips to minted if the worker later credits it');
}

// ---- recovery of a tETH settle: asset and amount net of the relay fee ----
{
  const world = makeWorld();
  const ux = makeUx(world, MULTI);
  const destXonly = destXonlyOf(WALLET_PRIV);
  const arrives = 390_000n;
  const { cx, cy } = pool.commitXY(arrives, deriveCrossoutBlinding(WALLET_PRIV, TNOTE.nullifier));
  const destCommitment = pool.btcNoteLeaf(TETH, cx, cy, withHex(destXonly));
  const h = withHex('e1'.repeat(32));
  world.setEthReceipt(h, { blockNumber: '0x2a', logs: [buildCrossOutRecordedLog({ claimId: CLAIM_ID, destChain: 1, destCommitment, nullifier: TNOTE.nullifier, assetId: TETH })] });
  const rec = await ux.recoverFromEthTx(h, WALLET_PRIV, { amount: arrives });
  ok(rec.source.ticker === 'tETH' && rec.source.amount === arrives && rec.source.assetId.toLowerCase() === TETH.toLowerCase(), 'a recovered tETH settle is a tETH record worth what arrives');
  let m = null; try { await makeUx(world, MULTI).recoverFromEthTx(h, WALLET_PRIV, { amount: arrives + 1n }); } catch (e) { m = e.message; }
  ok(/does not match/.test(m || ''), 'the amount is still checked against the event\'s commitment');
  // A TAC-only module does not take a tETH settle.
  let m2 = null; try { await makeUx(world).recoverFromEthTx(h, WALLET_PRIV, { amount: arrives }); } catch (e) { m2 = e.message; }
  ok(/different asset/.test(m2 || ''), 'a module configured for TAC alone refuses that same tETH settle as another asset');
}

// ---- a burn that lands after the page gave up on it is found again from Ethereum ----
{
  const settleLog = (fee, { block = 26_150_100, tx = 'b7', amountFor = (v) => v - fee, note = TNOTE } = {}) => {
    const amount = amountFor(note.value);
    const { cx, cy } = pool.commitXY(amount, deriveCrossoutBlinding(WALLET_PRIV, note.nullifier));
    const destCommitment = pool.btcNoteLeaf(note.asset, cx, cy, withHex(destXonlyOf(WALLET_PRIV)));
    return { ...buildCrossOutRecordedLog({ claimId: CLAIM_ID, destChain: 1, destCommitment, nullifier: note.nullifier, assetId: note.asset }),
      transactionHash: withHex(tx.repeat(32)), blockNumber: '0x' + block.toString(16), cx, cy, destCommitment };
  };
  const land = (world, ...logs) => { world.setCoverage({ ethHead: Math.max(...logs.map((l) => Number(BigInt(l.blockNumber)))) + 10 }); world.setLogs(logs); };
  const timeout = Object.assign(new Error('settle timed out'), {});
  const withPool = { ...MULTI, poolAddress: POOL_ADDR };

  // The relay timed out (or the tab closed): the intent is kept, the note stays reserved, and nothing is lost track of.
  {
    const world = makeWorld(); world.setCrossOutError(timeout);
    const ux = makeUx(world, withPool);
    let m = null; try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch (e) { m = e.message; }
    const rec = ux.list(WALLET_PUB)[0];
    ok(m === 'settle timed out' && rec.stage === 'settling', 'a settle the page could not see through leaves an intent record, not nothing');
    ok(rec.startBlock === 26_147_613 && rec.source.fee === 10_000n && rec.dests.length === 1 && rec.dests[0].amount === 390_000n, 'it keeps the block it began at, the fee, and the destination that fee would make');
    ok(ux.eligibleNotes([TNOTE])[0].reason === 'already bridging', 'the note stays reserved meanwhile');

    // Nothing on Ethereum yet: it waits, and says nothing is wrong.
    const waiting = await ux.advance(WALLET_PUB, TNOTE.nullifier);
    ok(waiting.stage === 'settling', 'with no settle on Ethereum yet it keeps waiting');

    // The relay settles it after all.
    land(world, settleLog(10_000n));
    const found = await ux.advance(WALLET_PUB, TNOTE.nullifier);
    ok(found.stage === 'settled' && found.settle.claimIdVerified === true && found.settle.ethBlock === 26_150_100, 'once the settle shows on Ethereum it becomes an ordinary settled record');
    ok(found.settle.txHash === 'b7'.repeat(32) && found.settle.claimId.toLowerCase() === CLAIM_ID.toLowerCase(), 'with its transaction and claim taken from the event');
    ok(found.source.fee === 10_000n && found.source.amount === 390_000n && found.source.value === 400_000n, 'and the amounts the fee implies');
    world.setEthCovered(true);
    const covered = await ux.advance(WALLET_PUB, TNOTE.nullifier);
    const signed = await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV });
    ok(covered.stage === 'covered' && signed.stage === 'mint-signed', 'and goes on to the Bitcoin step');
  }

  // A later attempt (self-settled, no relay fee) finds that an earlier, slower one landed: it is not sent twice.
  {
    const world = makeWorld(); world.setCrossOutError(timeout);
    const ux = makeUx(world, withPool);
    try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    world.setCrossOutError(null);
    land(world, settleLog(10_000n));
    const before = world.crossOutCalls.length;
    const rec = await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
    ok(rec.stage === 'settled' && rec.source.fee === 10_000n && world.crossOutCalls.length === before, 'a second attempt returns the first one that landed instead of burning twice');
  }

  // The second attempt, with another fee, is the one that lands: its own destination is recognised.
  {
    const world = makeWorld(); world.setCrossOutError(timeout);
    const ux = makeUx(world, withPool);
    try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n }); } catch {}
    const r = ux.list(WALLET_PUB)[0];
    ok(r.stage === 'settling' && r.dests.length === 2 && r.source.attempts.length === 2, 'both attempts\' destinations are kept on the one record');
    land(world, settleLog(0n));
    const found = await ux.advance(WALLET_PUB, TNOTE.nullifier);
    ok(found.stage === 'settled' && found.source.fee === 0n && found.source.amount === 400_000n, 'whichever lands is the one recognised, with its own amounts');
  }

  // A settle of this note to an amount it never asked for is not guessed at.
  {
    const world = makeWorld(); world.setCrossOutError(timeout);
    const ux = makeUx(world, withPool);
    try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    land(world, settleLog(0n, { amountFor: () => 1_234_567n }));
    let m = null; try { await ux.advance(WALLET_PUB, TNOTE.nullifier); } catch (e) { m = e.message; }
    ok(/amount this page did not ask for/.test(m || '') && ux.list(WALLET_PUB)[0].stage === 'settling', 'a settle of the note to some other amount is refused, and the record is left as it was');
    // Another note's settle in the same range is simply not ours.
    land(world, settleLog(0n, { note: { ...TNOTE, nullifier: withHex('99'.repeat(32)) } }));
    ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'settling', 'another note\'s settle is ignored');
  }

  // Without a pool address to look at, an intent just waits; it can be cancelled.
  {
    const world = makeWorld(); world.setCrossOutError(timeout);
    const ux = makeUx(world, MULTI);
    try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    land(world, settleLog(10_000n));
    ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'settling', 'with no pool address given a settling record waits rather than guessing');
    ux.abandon(WALLET_PUB, TNOTE.nullifier);
    ok(ux.list(WALLET_PUB).length === 0 && ux.eligibleNotes([TNOTE])[0].eligible, 'cancelling it frees the note');
  }

  // Cancelling looks once more first: a burn that had landed is not forgotten, and one that has not is let go.
  {
    const world = makeWorld(); world.setCrossOutError(timeout);
    const ux = makeUx(world, withPool);
    try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    land(world, settleLog(10_000n));
    const r1 = await ux.cancelIntent(WALLET_PUB, TNOTE.nullifier);
    ok(r1 && r1.stage === 'settled' && ux.list(WALLET_PUB)[0].stage === 'settled', 'cancelling a bridge whose burn had landed returns it as settled instead of dropping it');
    let m = null; try { await ux.cancelIntent(WALLET_PUB, TNOTE.nullifier); } catch (e) { m = e.message; }
    ok(/has not settled/.test(m || ''), 'a settled bridge cannot be cancelled');
    const w2 = makeWorld(); w2.setCrossOutError(timeout);
    const ux2 = makeUx(w2, withPool);
    try { await ux2.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    ok((await ux2.cancelIntent(WALLET_PUB, TNOTE.nullifier)) === null && ux2.list(WALLET_PUB).length === 0, 'with nothing on Ethereum it is let go');
    const ux3 = makeUx(w2, MULTI);
    try { await ux3.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    let m3 = null; try { await ux3.cancelIntent(WALLET_PUB, TNOTE.nullifier); } catch (e) { m3 = e.message; }
    ok(/cannot be checked against Ethereum/.test(m3 || '') && ux3.list(WALLET_PUB).length === 1, 'without a pool to look at it is not dropped blind');
  }

  // Search is paged: a settle days after the intent is still found.
  {
    const world = makeWorld(); world.setCrossOutError(timeout);
    const ux = makeUx(world, withPool);
    try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    land(world, settleLog(10_000n, { block: 26_147_613 + 11_000 }));
    ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'settled', 'a settle many thousands of blocks after the intent is found across the pages');
  }
}

// ---- the destination worked out beforehand is the one the real bridge-burn builder makes ----
{
  const { makeConfidentialTransfer } = await import('../dapp/confidential-transfer.js');
  const { randomScalar } = await import('../dapp/bulletproofs-plus.js');
  const ct = makeConfidentialTransfer({ keccak256: keccak_256 });
  const amount = 390_000n, destOwner = destXonlyOf(WALLET_PRIV);
  const built = ct.buildBridgeBurn({
    inputs: [{ value: 400_000n, blinding: randomScalar() }], outputs: [{ value: amount, blinding: deriveCrossoutBlinding(WALLET_PRIV, TNOTE.nullifier), owner: destOwner }],
    assetId: TETH, destChain: 1, bindNullifier: TNOTE.nullifier, fee: 10_000n,
  });
  const co = built.crossOuts[0];
  const world = makeWorld();
  const ux = makeUx(world, MULTI);
  const h = withHex('c9'.repeat(32));
  world.setEthReceipt(h, { blockNumber: '0x10', logs: [buildCrossOutRecordedLog({ claimId: co.claimId, destChain: 1, destCommitment: co.destCommitment, nullifier: TNOTE.nullifier, assetId: TETH })] });
  const rec = await ux.recoverFromEthTx(h, WALLET_PRIV, { amount });
  ok(rec.settle.cx.toLowerCase() === co.cx.toLowerCase() && rec.settle.cy.toLowerCase() === co.cy.toLowerCase(), 'the real builder\'s cx/cy are the ones worked out from the key, the nullifier and the amount');
  ok(rec.settle.destCommitment.toLowerCase() === co.destCommitment.toLowerCase() && rec.settle.claimId.toLowerCase() === co.claimId.toLowerCase(), 'and so are its destination commitment and claim');
}

// ---- a reorged reveal, a second pair credited, recovery that leaves progress alone, and a step's error written onto the current record ----
{
  const readyToConfirm = async (extra = {}) => {
    const world = makeWorld(); const ux = makeUx(world, { ...MULTI, ...extra });
    await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
    world.setEthCovered(true);
    await ux.advance(WALLET_PUB, TNOTE.nullifier);
    const signed = await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV });
    await ux.advance(WALLET_PUB, TNOTE.nullifier);
    world.mineRevealTxid(signed.mint.revealTxid);
    await ux.advance(WALLET_PUB, TNOTE.nullifier);
    return { world, ux, signed };
  };
  {
    const { world, ux, signed } = await readyToConfirm();
    ok(ux.list(WALLET_PUB)[0].stage === 'mint-confirmed', 'set up: confirmed on Bitcoin');
    world.unconfirmTxid(signed.mint.revealTxid);
    world.setCredit({ decided: false, minted: false });
    ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'mint-submitted', 'a reveal reorged out of its block goes back to waiting for a confirmation, instead of waiting on a credit that cannot come');
  }
  {
    // Signed again after the first pair seemed not to be taken; the first one is the one credited.
    const { world, ux, signed } = await readyToConfirm();
    world.setCredit({ decided: true, minted: false, mintedTxid: '77'.repeat(32) });
    const after = await ux.advance(WALLET_PUB, TNOTE.nullifier);
    ok(after.stage === 'minted' && after.creditedTxid === '77'.repeat(32), 'a claim credited to another reveal of the same bridge is an arrival, not a refusal');
    void signed;
  }
  {
    // Recovering a bridge this module already follows past 'settled' changes nothing.
    const { world, ux, signed } = await readyToConfirm();
    const { cx, cy } = pool.commitXY(TNOTE.value, deriveCrossoutBlinding(WALLET_PRIV, TNOTE.nullifier));
    const destCommitment = pool.btcNoteLeaf(TETH, cx, cy, withHex(destXonlyOf(WALLET_PRIV)));
    const h = withHex('d4'.repeat(32));
    world.setEthReceipt(h, { blockNumber: '0x20', logs: [buildCrossOutRecordedLog({ claimId: CLAIM_ID, destChain: 1, destCommitment, nullifier: TNOTE.nullifier, assetId: TETH })] });
    const before = ux.list(WALLET_PUB)[0];
    const got = await ux.recoverFromEthTx(h, WALLET_PRIV, { amount: TNOTE.value });
    const now_ = ux.list(WALLET_PUB)[0];
    ok(got.stage === before.stage && now_.stage === 'mint-confirmed' && now_.mint.revealTxid === signed.mint.revealTxid, 'recovering a bridge that is already under way returns it as it is, signed mint and all');
  }
  {
    // Only the pool's own events are recovered from, when the pool is known.
    const world = makeWorld(); const ux = makeUx(world, { ...MULTI, poolAddress: POOL_ADDR });
    const { cx, cy } = pool.commitXY(TNOTE.value, deriveCrossoutBlinding(WALLET_PRIV, TNOTE.nullifier));
    const destCommitment = pool.btcNoteLeaf(TETH, cx, cy, withHex(destXonlyOf(WALLET_PRIV)));
    const h = withHex('d5'.repeat(32));
    const lg = buildCrossOutRecordedLog({ claimId: CLAIM_ID, destChain: 1, destCommitment, nullifier: TNOTE.nullifier, assetId: TETH });
    world.setEthReceipt(h, { blockNumber: '0x20', logs: [{ ...lg, address: '0x' + '9'.repeat(40) }] });
    let m = null; try { await ux.recoverFromEthTx(h, WALLET_PRIV, { amount: TNOTE.value }); } catch (e) { m = e.message; }
    ok(/no CrossOutRecorded/.test(m || ''), 'a lookalike event from some other contract is not a settle');
    world.setEthReceipt(h, { blockNumber: '0x20', logs: [{ ...lg, address: POOL_ADDR.toLowerCase() }] });
    ok((await ux.recoverFromEthTx(h, WALLET_PRIV, { amount: TNOTE.value })).stage === 'settled', 'the pool\'s own event is');
  }
  {
    // A step that fails writes only its error, onto the record as it is by then.
    const store = new Map();
    const storage = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k), get length() { return store.size; }, key: (i) => Array.from(store.keys())[i] || null };
    const world = makeWorld(); world.setCrossOutError(Object.assign(new Error('settle timed out'), {}));
    const ux = makeUx(world, { ...MULTI, storage, poolAddress: POOL_ADDR });
    try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    const key = Array.from(store.keys()).find((k) => k.includes(':mainnet:') && !k.includes(':lease:'));
    const base = world.fetchImpl; let hits = 0;
    // The reconcile's own rpc fails after another tab has added an attempt to the record.
    world.rpc = async (m, p) => { if (m === 'eth_blockNumber') { hits++; const list = JSON.parse(store.get(key)); list[0].source.attempts = ['10000', '0']; store.set(key, JSON.stringify(list)); throw new Error('rpc down'); } return null; };
    const ux2 = makeCrossoutUx({ network: 'mainnet', hrp: 'bc', workerBase: 'http://worker', fetchImpl: base, storage, secp, hmac, sha256: nobleSha256, crossOut: world.crossOut, pool, rpc: (m, p) => world.rpc(m, p), evmLog, chain: world.chain, ...MULTI, poolAddress: POOL_ADDR });
    let m = null; try { await ux2.advance(WALLET_PUB, TNOTE.nullifier); } catch (e) { m = e.message; }
    const rec = JSON.parse(store.get(key))[0];
    ok(hits === 1 && m === 'rpc down' && rec.lastError.message === 'rpc down' && rec.source.attempts.join() === '10000,0', 'the error is written onto the record as it is now, keeping what another tab added meanwhile');
  }
}

// ---- each mint transaction pays at least the relay floor for the size it really has ----
{
  const { makeCrossoutMintReveal, vsizeOfHex } = await import('../dapp/crossout-mint-reveal.js');
  const mr = makeCrossoutMintReveal({ secp });
  const destX = destXonlyOf(WALLET_PRIV);
  const P = makeBtcWallet({ priv: WALLET_PRIV, hrp: 'bc', fetchUtxos: async () => [], broadcastTx: async () => {}, fetchFeeRate: async () => 1 }).prims;
  for (const rate of [1, 1.4, 3, 40]) {
    const b = mr.buildCrossoutMintTxs({ prims: P, assetId: TETH, claimId: CLAIM_ID, cx: CX, cy: CY, destXonly: destX, fundingUtxo: { txid: FUND_TXID, vout: 0, value: 400_000 }, feeRate: rate });
    const cv = vsizeOfHex(b.commitHex), rv = vsizeOfHex(b.revealHex);
    ok(b.commitFee >= cv && b.revealFee >= rv, `at ${rate} sat/vB the commit (${cv} vB, pays ${b.commitFee}) and the reveal (${rv} vB, pays ${b.revealFee}) each pay at least 1 sat/vB`);
  }
  const low = mr.buildCrossoutMintTxs({ prims: P, assetId: TETH, claimId: CLAIM_ID, cx: CX, cy: CY, destXonly: destX, fundingUtxo: { txid: FUND_TXID, vout: 0, value: 50_000 }, feeRate: 0.2 });
  ok(low.feeRate === 1 && low.commitFee >= vsizeOfHex(low.commitHex), 'a quoted rate under the relay floor is raised to it, not signed as it is');
  ok(vsizeOfHex(low.commitHex) <= 154 && vsizeOfHex(low.revealHex) <= 180, 'and the sizes it budgets (154 and 180 vB) cover the real ones');
}

// ---- found by a second review: a dropped mint is sent again, cancel keeps a spent note's record, a key and a page guard ----
{
  const fresh = async (extra = {}) => {
    const world = makeWorld(); const ux = makeUx(world, { ...MULTI, ...extra });
    await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
    world.setEthCovered(true);
    await ux.advance(WALLET_PUB, TNOTE.nullifier);
    const signed = await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV });
    const sent = await ux.advance(WALLET_PUB, TNOTE.nullifier);
    return { world, ux, signed, sent };
  };
  {
    const { world, ux, signed, sent } = await fresh();
    ok(sent.stage === 'mint-submitted', 'set up: sent to Bitcoin');
    world.dropTx(signed.mint.revealTxid);                         // an explorer that has never heard of it answers 404 with plain text
    const before = world.broadcasts.length;
    const again = await ux.advance(WALLET_PUB, TNOTE.nullifier);
    ok(again.stage === 'mint-submitted' && world.broadcasts.length === before + 2 && world.broadcasts.slice(-2)[0] === signed.mint.commitHex && world.broadcasts.slice(-1)[0] === signed.mint.revealHex,
      'a mint the explorer answers 404 for is offered to Bitcoin again, the same signed pair, commit first');
    world.setBroadcastError(new Error('bad-txns-inputs-missingorspent'));
    let m = null; try { await ux.advance(WALLET_PUB, TNOTE.nullifier); } catch (e) { m = e.message; }
    const row = ux.list(WALLET_PUB)[0];
    ok(/did not take the signed transactions again: bad-txns-inputs-missingorspent/.test(m || '') && row.lastError && row.errorCount === 1, 'when Bitcoin refuses them again, the record says so');
    world.setBroadcastError(null);
    const re = await ux.resign(WALLET_PUB, TNOTE.nullifier);
    ok(re.stage === 'covered' && !re.mint, 'and a signed pair Bitcoin does not have and will not take can be signed again from a free coin');
    world.restoreTx(signed.mint.revealTxid);
  }
  {
    const { world, ux, signed } = await fresh();
    world.dropTx(signed.mint.commitTxid);
    world.mineRevealTxid(signed.mint.revealTxid);
    // The reveal confirmed and the commit is unknown to the explorer: resign must not run while the reveal is on Bitcoin.
    ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'mint-confirmed', 'a confirmed reveal moves on');
    world.dropTx(signed.mint.revealTxid);
    ok((await ux.advance(WALLET_PUB, TNOTE.nullifier)).stage === 'mint-submitted', 'a confirmed reveal that is then gone from Bitcoin goes back to being sent');
  }
  {
    const { world, ux, signed } = await fresh();
    world.mineRevealTxid(signed.mint.commitTxid);                 // Bitcoin has the commit
    let m = null; try { await ux.resign(WALLET_PUB, TNOTE.nullifier); } catch (e) { m = e.message; }
    ok(/already on Bitcoin/.test(m || '') && ux.list(WALLET_PUB)[0].stage === 'mint-submitted' && !!ux.list(WALLET_PUB)[0].mint, 'a pair Bitcoin has is not signed again');
  }
  {
    // A key that is not the bridge's does not sign its Bitcoin step.
    const world = makeWorld(); const ux = makeUx(world, MULTI);
    await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
    world.setEthCovered(true);
    await ux.advance(WALLET_PUB, TNOTE.nullifier);
    const other = new Uint8Array(32).fill(0x34);
    let m = null; try { await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: other }); } catch (e) { m = e.message; }
    ok(/belongs to another key/.test(m || '') && ux.list(WALLET_PUB)[0].stage === 'covered' && !ux.list(WALLET_PUB)[0].lastError, 'another key is refused before anything is signed, and the bridge is left as it was');
  }
  {
    // Two advances of one bridge in one page do not both sign.
    const world = makeWorld(); const ux = makeUx(world, MULTI);
    await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 0n });
    world.setEthCovered(true);
    await ux.advance(WALLET_PUB, TNOTE.nullifier);
    const a = ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV });
    let m = null; try { await ux.advance(WALLET_PUB, TNOTE.nullifier, { walletPriv: WALLET_PRIV }); } catch (e) { m = e.message; }
    const first = await a;
    ok(/being advanced in this page right now/.test(m || '') && first.stage === 'mint-signed' && ux.list(WALLET_PUB)[0].mint.revealTxid === first.mint.revealTxid, 'a second advance of the same bridge in the same page is refused while the first is signing');
  }
  {
    // Cancel keeps a record whose note the pool has spent.
    const world = makeWorld(); world.setCrossOutError(Object.assign(new Error('settle timed out'), {}));
    let spent = false;
    const ux = makeUx(world, { ...MULTI, poolAddress: POOL_ADDR, nullifierSpent: async () => spent });
    try { await ux.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    spent = true;
    let m = null; try { await ux.cancelIntent(WALLET_PUB, TNOTE.nullifier); } catch (e) { m = e.message; }
    ok(/has been spent on Ethereum/.test(m || '') && ux.list(WALLET_PUB).length === 1, 'a bridge whose note the pool has spent is not cancelled: its burn may have landed');
    spent = false;
    ok((await ux.cancelIntent(WALLET_PUB, TNOTE.nullifier)) === null && ux.list(WALLET_PUB).length === 0, 'and one whose note is unspent, with no settle found, is let go');
    const bad = makeUx(world, { ...MULTI, poolAddress: POOL_ADDR, nullifierSpent: async () => { throw new Error('rpc'); } });
    try { await bad.start({ note: TNOTE, walletPriv: WALLET_PRIV, fee: 10_000n }); } catch {}
    m = null; try { await bad.cancelIntent(WALLET_PUB, TNOTE.nullifier); } catch (e) { m = e.message; }
    ok(/could not check whether this note was spent/.test(m || '') && bad.list(WALLET_PUB).length === 1, 'and one that cannot be checked is kept too');
  }
}

console.log(`\n${n} crossout-ux checks passed${failures ? `, ${failures} FAILED` : ''}`);
process.exit(failures ? 1 : 0);
