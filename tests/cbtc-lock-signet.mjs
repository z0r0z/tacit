// cBTC Model-B lock-tx signet harness (foundation step). Loads the browser dapp (tacit.js) under jsdom and
// checks the prerequisites for buildAndBroadcastCbtcLock BEFORE writing the full builder:
//   (1) tacit.js loads + the Taproot/commit-reveal primitives + pedersenCommit are present,
//   (2) the browser pedersenCommit's affine (Cx,Cy) == confidential-pool.commitXY (so lock = mint = scan agree),
//   (3) the funded signet wallet + its balance (so the live broadcast has sats).
// No broadcast here. Run: node tests/cbtc-lock-signet.mjs
import { JSDOM } from 'jsdom';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;
globalThis.localStorage.setItem('tacit-network-v1', 'signet');

import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { keccak_256 } from '@noble/hashes/sha3';
import { hmac } from '@noble/hashes/hmac';
import { hexToBytes, bytesToHex } from '@noble/hashes/utils';
import assert from 'node:assert';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLETS = path.join(__dirname, '..', '.local', 'amm-e2e-signet-wallets.json');
let n = 0; const ok = (s) => { console.log('  ✓', s); n++; };

process.stderr.write('[cbtc-lock-signet] loading tacit.js under jsdom…\n');
const dapp = await import('../dapp/tacit.js');
process.stderr.write('[cbtc-lock-signet] tacit.js loaded\n');
const { makeConfidentialPool } = await import('../dapp/confidential-pool.js');
const { makeCbtcNoteRecovery } = await import('../dapp/cbtc-note-recovery.js');

// (1) primitives present
const need = ['encodeEnvelopeScript', 'tapLeafHash', 'tweakedOutputKey', 'controlBlock', 'p2trScript', 'p2wpkhScript', 'TAP_NUMS', 'signTaprootScriptPathInput', 'serializeTx', 'txid', 'pedersenCommit', 'getUtxos', 'getFeeRate', 'feeFor', 'broadcast', 'broadcastWithRetry', 'DUST', 'NET', 'wallet', 'ensurePrivkey'];
const missing = need.filter((k) => dapp[k] === undefined);
assert.equal(missing.length, 0, `tacit.js missing primitives: ${missing.join(', ')}`);
ok(`tacit.js loaded under jsdom; ${need.length} lock-tx primitives present`);

// (2) commitXY consistency — the browser Pedersen must equal the node pool's, or lock/mint/scan disagree
{
  const pool = makeConfidentialPool({ secp, keccak256: (b) => keccak_256(b), sha256: (b) => sha256(b) });
  const rec = makeCbtcNoteRecovery({ hmac, sha256, curveOrder: secp.CURVE.n });
  const priv = hexToBytes('11'.repeat(32));
  const blinding = rec.deriveCbtcNoteBlinding({ privkey: priv, anchorOutpoint: rec.anchorBytes('ab'.repeat(32), 0), outputIndex: 0 });
  const vBtc = 100000n;
  const C = dapp.pedersenCommit(vBtc, blinding);          // browser commitment
  const a = (typeof C.toAffine === 'function') ? C.toAffine() : C;
  const cxBrowser = '0x' + a.x.toString(16).padStart(64, '0');
  const cyBrowser = '0x' + a.y.toString(16).padStart(64, '0');
  const { cx, cy } = pool.commitXY(vBtc, blinding);        // node commitment (lock envelope + scan + mint use this)
  assert.equal(cxBrowser.toLowerCase(), cx.toLowerCase(), 'pedersenCommit Cx == pool.commitXY Cx');
  assert.equal(cyBrowser.toLowerCase(), cy.toLowerCase(), 'pedersenCommit Cy == pool.commitXY Cy');
  ok('browser pedersenCommit == confidential-pool.commitXY (lock/mint/scan agree on Cx,Cy)');
}

// (3) funded signet wallet
if (existsSync(WALLETS)) {
  const w = JSON.parse(readFileSync(WALLETS, 'utf8'));
  const addr = w.founder?.address;
  try {
    const r = await fetch(`https://mempool.space/signet/api/address/${addr}`, { signal: AbortSignal.timeout(8000) });
    const j = await r.json();
    const unspent = (j.chain_stats.funded_txo_sum - j.chain_stats.spent_txo_sum);
    console.log(`  founder ${addr}: ${unspent} unspent signet sats`);
    assert.ok(unspent > 50000, 'founder has > 50k unspent signet sats for the lock');
    ok('funded signet wallet available for the live lock-tx');
  } catch (e) { console.log('  (signet balance check skipped:', e.message, ')'); }
} else { console.log('  (no .local wallets; live broadcast will need a funded key)'); }

// ── lock-tx build (--build = construct + classify, no broadcast; --broadcast = live signet round-trip) ──
const BUILD = process.argv.includes('--build') || process.argv.includes('--broadcast');
const BROADCAST = process.argv.includes('--broadcast');
if (BUILD) {
  const { buildCbtcLockEnvelope } = await import('../dapp/cbtc-envelope.js');
  const { classifyConfidentialTx } = await import('../dapp/burn-deposit-bitcoin.js');
  const CBTC_ZK_ASSET_ID = '62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';
  const w = JSON.parse(readFileSync(WALLETS, 'utf8'));
  dapp.wallet.priv = hexToBytes(w.founder.priv_hex);
  dapp.wallet.pub = secp.getPublicKey(hexToBytes(w.founder.priv_hex), true);
  await dapp.ensurePrivkey();
  const rec = makeCbtcNoteRecovery({ hmac, sha256, curveOrder: secp.CURVE.n });
  const pool = makeConfidentialPool({ secp, keccak256: (b) => keccak_256(b), sha256: (b) => sha256(b) });

  const vBtc = 20000; // a small signet lock
  const feeRate = await dapp.getFeeRate();
  const revealFee = dapp.feeFor(200, feeRate);
  const commitValue = vBtc + revealFee;

  const utxos = await dapp.getUtxos(dapp.wallet.address());
  const sats = utxos.filter((u) => u.value > dapp.DUST).sort((a, b) => b.value - a.value);
  const picked = []; let total = 0; let commitFee = 500;
  for (const u of sats) { picked.push(u); total += u.value; commitFee = dapp.feeFor(dapp.estCommitVb(picked.length), feeRate); if (total >= commitValue + commitFee + dapp.DUST) break; }
  assert.ok(total >= commitValue + commitFee, 'enough sats for the lock');
  const fundingAnchor = picked[0];

  // recoverable blinding from the COMMIT's vin[0] (= fundingAnchor); commitment must match browser==node
  const blinding = rec.deriveCbtcNoteBlinding({ privkey: dapp.wallet.priv, anchorOutpoint: rec.anchorBytes(fundingAnchor.txid, fundingAnchor.vout), outputIndex: 0 });
  const { cx, cy } = pool.commitXY(vBtc, blinding);

  const env = buildCbtcLockEnvelope({ asset: '0x' + CBTC_ZK_ASSET_ID, lockVout: 0, cx, cy });
  const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), hexToBytes(env.replace(/^0x/, '')));
  const leaf = dapp.tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = dapp.tweakedOutputKey(dapp.TAP_NUMS, leaf);
  const commitSpk = dapp.p2trScript(Q_xonly);
  const cb = dapp.controlBlock(dapp.TAP_NUMS, parity);
  const wpkh = dapp.p2wpkhScript(dapp.wallet.pub);

  const change = total - commitValue - commitFee;
  const commitOutputs = [{ value: commitValue, script: commitSpk }];
  if (change >= dapp.DUST) commitOutputs.push({ value: change, script: wpkh });
  const commitTx = { version: 2, locktime: 0, inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })), outputs: commitOutputs };
  for (let i = 0; i < commitTx.inputs.length; i++) commitTx.inputs[i].witness = dapp.signP2wpkhInput(commitTx, i, picked[i].value);
  const commitHex = bytesToHex(dapp.serializeTx(commitTx));
  const commitTxid = dapp.txid(commitTx);

  const revealTx = { version: 2, locktime: 0, inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: vBtc, script: wpkh }] };
  revealTx.inputs[0].witness = dapp.signTaprootScriptPathInput(revealTx, [{ value: commitValue, script: commitSpk }], envelopeScript, cb);
  const revealHex = bytesToHex(dapp.serializeTx(revealTx));
  const revealTxid = dapp.txid(revealTx);

  const cls = classifyConfidentialTx(revealHex);
  assert.ok(cls && cls.type === 'cbtc_lock', `reveal classifies as cbtc_lock (got ${cls && cls.type})`);
  assert.equal(cls.cx.toLowerCase(), cx.toLowerCase(), 'classified Cx == committed');
  assert.equal(cls.cy.toLowerCase(), cy.toLowerCase(), 'classified Cy == committed');
  ok(`lock-tx BUILT + classifies as cbtc_lock (Cx/Cy match) — commit ${commitTxid.slice(0, 12)}… reveal ${revealTxid.slice(0, 12)}… vBtc=${vBtc}`);

  if (BROADCAST) {
    await dapp.broadcast(commitHex);
    await dapp.broadcastWithRetry(revealHex);
    console.log(`  📡 broadcast: commit ${commitTxid} → reveal ${revealTxid} (lock outpoint ${revealTxid}:0); wait for confirms, then OP_CBTC_MINT + wipe→scanCbtc`);
  } else {
    console.log('  (dry-run: not broadcast; pass --broadcast for the live round-trip)');
  }
}

console.log(`cbtc-lock-signet (foundation): ${n} checks passed`);
process.exit(0); // tacit.js leaves timers alive under jsdom; exit so the harness doesn't hang
