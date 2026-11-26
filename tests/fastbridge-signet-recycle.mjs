// Live-signet proof for the stuck-TAC recycler: etch a small Tacit note at the main provider key, move it with the same
// tacit.buildAndBroadcastCXferMulti call the daemon's recycler uses to the production-derived reverse key, then find it by a
// scan as the reverse key. Resumable from its state file; secrets stay in ~/.tacit-validation, not in the repo.
//
//   FB_RECYCLE_KEY_FILE=~/.tacit-validation/signet-recycle.json node tests/fastbridge-signet-recycle.mjs
// The key file is { "priv_hex": "...", "address": "tb1q..." }; the address only needs a small confirmed signet coin.

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { bytesToHex, concatBytes, hexToBytes, hmac, secp, sha256 } from '../dapp/vendor/tacit-deps.min.js';
import { bigintToBytes32, pedersenCommit, SECP_N } from '../dapp/bulletproofs.js';
import { makeBtcWallet } from '../dapp/bitcoin-taproot-wallet.js';
import { makeAdaptorBtcTx, tacitKit } from '../dapp/adaptor-btc-tx.js';
import { makeEsploraBtcChain } from '../dapp/fastbridge-btc.js';
import { loadTacit } from '../worker-relay/src/lib/btc-pool-transparent.js';
import { reverseKeyOf } from '../fastbridge-lp/lib/reverse.mjs';
import { bpRangeAggProve } from './bulletproofs.mjs';

const DIR = join(homedir(), '.tacit-validation');
const KEY_FILE = process.env.FB_RECYCLE_KEY_FILE || join(DIR, 'signet-recycle.json');
const STATE = process.env.FB_RECYCLE_STATE || join(DIR, 'fastbridge-signet-recycle-state.json');
const BASES = ['https://mempool.space/signet/api', 'https://blockstream.info/signet/api'];
const FEE_RATE = 2, NOTE = 5_000n, DUST = 546, POLL_MS = 30_000;
const te = (s) => new TextEncoder().encode(s);
const log = (msg, o = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...o }));
const later = (ms) => new Promise((r) => setTimeout(r, ms));

secp.etc.hmacSha256Sync = (k, ...m) => hmac(sha256, k, secp.etc.concatBytes(...m));
const keyFile = JSON.parse(readFileSync(KEY_FILE, 'utf8'));
const mainPriv = hexToBytes(keyFile.priv_hex);
const walletOf = (priv) => makeBtcWallet({ priv, hrp: 'tb', fetchUtxos: async () => [], broadcastTx: async () => { throw new Error('broadcast goes through the chain adapter or tacit.js'); }, fetchFeeRate: async () => FEE_RATE }).prims;
const main = walletOf(mainPriv);
assert.equal(main.wallet.address(), keyFile.address, 'the key file address does not match its key');
const reversePriv = reverseKeyOf(mainPriv), reverse = walletOf(reversePriv);
assert.notEqual(reverse.wallet.address(), main.wallet.address());

const tacit = await loadTacit('signet');
delete globalThis.location;
const kit = tacitKit(tacit);
const builder = makeAdaptorBtcTx({ prims: main, kit });
const chain = makeEsploraBtcChain({ bases: BASES, prims: main, builder });
const own = (p) => p.p2wpkhScript(p.wallet.pub);
const S = existsSync(STATE) ? JSON.parse(readFileSync(STATE, 'utf8')) : {};
const keep = () => { mkdirSync(dirname(STATE), { recursive: true }); writeFileSync(STATE, JSON.stringify(S, null, 1), { mode: 0o600 }); };
const confirmed = async (txid) => ((await chain.status(txid).catch(() => null)) || {}).confirmations > 0;
async function untilConfirmed(txid, label) {
  for (;;) {
    if (await confirmed(txid)) return;
    log('waiting for a block', { label, txid });
    await later(POLL_MS);
  }
}
async function broadcastSaved(name, pair) {
  if (!S[name]) { S[name] = pair; keep(); }
  await chain.broadcast({ commitHex: S[name].commitHex, revealHex: S[name].revealHex });
  log('sent', { step: name, commit: S[name].commitTxid, reveal: S[name].revealTxid });
}

const coins = await chain.satsUtxos();
assert.ok(coins.length, `${main.wallet.address()} needs one confirmed plain signet coin`);
log('main key funded', { address: main.wallet.address(), coins: coins.length, sats: coins.reduce((s, c) => s + c.value, 0) });

// A note at the main provider address, etched with the production payload/validator shape.
const rNote = BigInt('0x' + bytesToHex(sha256(concatBytes(mainPriv, te('stuck-recycle-note'))))) % (SECP_N - 1n) + 1n;
if (!S.etch) {
  const coin = coins[0], ticker = 'SR' + (await chain.tip()).toString(36).toUpperCase();
  const { proof } = bpRangeAggProve([NOTE], [rNote]);
  const payload = tacit.encodeCEtchPayload({ ticker, decimals: 0, commitment: pedersenCommit(NOTE, rNote).toRawBytes(true), rangeproof: proof, encryptedAmount: new Uint8Array(8) });
  const script = main.encodeEnvelopeScript(main.wallet.xonly(), payload);
  const { Q_xonly, parity } = main.tweakedOutputKey(main.TAP_NUMS, main.tapLeafHash(script));
  const commitSpk = main.p2trScript(Q_xonly), revealVb = 80 + Math.ceil((script.length + 100) / 4), commitValue = DUST + FEE_RATE * revealVb, commitFee = FEE_RATE * 180;
  const commitTx = { version: 2, locktime: 0, inputs: [{ txid: coin.txid, vout: coin.vout, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: commitValue, script: commitSpk }, { value: coin.value - commitValue - commitFee, script: own(main) }] };
  main.signCommitInputs(commitTx, [coin], own(main));
  const commitTxid = main.txid(commitTx);
  const revealTx = { version: 2, locktime: 0, inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: DUST, script: own(main) }] };
  revealTx.inputs[0].witness = main.signTaprootScriptPathInput(revealTx, [{ value: commitValue, script: commitSpk }], script, main.controlBlock(main.TAP_NUMS, parity));
  S.etch = { ticker, commitTxid, revealTxid: main.txid(revealTx), commitHex: bytesToHex(main.serializeTx(commitTx)), revealHex: bytesToHex(main.serializeTx(revealTx)) };
  keep();
}
await broadcastSaved('etch', S.etch);
await untilConfirmed(S.etch.revealTxid, 'etch');
const assetIdRaw = tacit.assetIdFor(S.etch.revealTxid, 0), assetIdHex = typeof assetIdRaw === 'string' ? assetIdRaw : bytesToHex(assetIdRaw);
log('etched note confirmed', { ticker: S.etch.ticker, txid: S.etch.revealTxid, assetIdHex });

// The recycler's exact spend path: one forced input, one recipient, the production-derived reverse public key.
const note = { utxo: { txid: S.etch.revealTxid, vout: 0, value: DUST, status: { confirmed: true } }, amount: NOTE, blinding: rNote };
if (!S.recycle) {
  tacit.wallet.priv = mainPriv; tacit.wallet.pub = main.wallet.pub;
  try { if (typeof tacit.invalidateHoldingsCache === 'function') tacit.invalidateHoldingsCache(); } catch { /* no cache yet */ }
  const r = await tacit.buildAndBroadcastCXferMulti({ assetIdHex, recipients: [{ pubHex: bytesToHex(reverse.wallet.pub), amount: NOTE }], forceUtxos: [note] });
  S.recycle = { commitTxid: r.commitTxid, revealTxid: r.revealTxid, amount: String(NOTE), assetIdHex };
  keep();
}
log('recycle transfer sent', { commit: S.recycle.commitTxid, reveal: S.recycle.revealTxid, reverseAddress: reverse.wallet.address() });
await untilConfirmed(S.recycle.revealTxid, 'recycle transfer');

// Read it back as the reverse key: this is what makeReverseInventory().notes() does in the daemon.
tacit.wallet.priv = reversePriv; tacit.wallet.pub = reverse.wallet.pub;
try { if (typeof tacit.invalidateHoldingsCache === 'function') tacit.invalidateHoldingsCache(); } catch { /* forced scan below */ }
const holdings = await tacit.scanHoldings(true);
const got = ((holdings instanceof Map ? holdings.get(assetIdHex) : null) || {}).utxos || [];
const found = got.find((x) => x.utxo && x.utxo.txid === S.recycle.revealTxid && x.utxo.vout === 0 && BigInt(x.amount) === NOTE && !x.stealthTweakedSk);
assert.ok(found, 'the reverse key did not scan the recycled output at vout 0');
S.verified = { txid: S.recycle.revealTxid, vout: 0, amount: String(found.amount), assetIdHex, mainAddress: main.wallet.address(), reverseAddress: reverse.wallet.address() };
keep();
log('verified', { ...S.verified, mempool: `https://mempool.space/signet/tx/${S.recycle.revealTxid}` });
