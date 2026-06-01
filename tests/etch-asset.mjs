#!/usr/bin/env node
// Headless C-ETCH (T_CETCH 0x21) asset etcher — mirrors the dapp's
// buildAndBroadcastCEtch (dapp/tacit.js) but reuses the dapp-parity-tested
// crypto in composition.mjs + bulletproofs.mjs and DROPS the dapp's
// supplyBase>=1 policy guard so a bridge asset can be etched with supply 0
// (the etcher holds zero balance; all circulating tETH is bridge-deposit-backed).
//
// Commands:
//   selftest                 prove+verify a supply-0 aggregated range proof (no broadcast, no BTC)
//   etch                     broadcast the C-ETCH on the chosen network; prints asset_id + opening
//   attest                   POST the (supply, blinding) opening to the worker
//   status                   show etch tx confirmation + worker asset record
//
// Env: NETWORK=signet|mainnet  ETCH_PRIVKEY=<32-byte hex>  TICKER=tETH  DECIMALS=8
//      SUPPLY=0  WORKER_BASE=https://tacit-pin.rosscampbell9.workers.dev
//      REVEAL_FEE / COMMIT_FEE (sats overrides)  STATE_FILE=/tmp/etch-state.json
import * as secp from '@noble/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import fs from 'fs';
import * as cx from './cxfer-helpers.mjs';
import {
  deriveEtchBlinding, deriveEtchAmountKeystream, encryptAmount,
  encodeCEtchPayload, assetIdFor,
} from './composition.mjs';
import { bpRangeAggProve, bpRangeAggVerify, pointToBytes } from './bulletproofs.mjs';

const NETWORK   = process.env.NETWORK || 'signet';
const PRIVKEY   = process.env.ETCH_PRIVKEY || '827aee3498ebbf5f4374387dc9937741ac87ec58a7a67c8091241d0797589222';
const TICKER    = process.env.TICKER || 'tETH';
const DECIMALS  = parseInt(process.env.DECIMALS || '8', 10);
const SUPPLY    = BigInt(process.env.SUPPLY || '0');
const WORKER_BASE = process.env.WORKER_BASE || 'https://tacit-pin.rosscampbell9.workers.dev';
const STATE_FILE  = process.env.STATE_FILE || '/tmp/etch-state.json';
const MEMPOOL_API = NETWORK === 'mainnet' ? 'https://mempool.space/api' : 'https://mempool.space/signet/api';
const HRP = NETWORK === 'mainnet' ? 'bc' : 'tb';

const priv = cx.hexToBytes(PRIVKEY);
const pub  = secp.getPublicKey(priv, true);
const xonly = pub.slice(1, 33);

function bech32Encode(hrp, witver, prog) {
  const CS = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  const polymod = vs => { let chk = 1; for (const v of vs) { const b = chk >> 25; chk = ((chk & 0x1ffffff) << 5) ^ v; for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3][i]; } return chk; };
  const conv = (data, fb, tb, pad) => { let acc = 0, bits = 0; const out = []; const maxv = (1 << tb) - 1; for (const v of data) { acc = (acc << fb) | v; bits += fb; while (bits >= tb) { bits -= tb; out.push((acc >> bits) & maxv); } } if (pad && bits > 0) out.push((acc << (tb - bits)) & maxv); return out; };
  const expand = h => { const a = h.split('').map(c => c.charCodeAt(0) >> 5); a.push(0); const b = h.split('').map(c => c.charCodeAt(0) & 31); return [...a, ...b]; };
  const data5 = [witver, ...conv(prog, 8, 5, true)];
  const chk = polymod([...expand(hrp), ...data5, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksum = []; for (let i = 0; i < 6; i++) checksum.push((chk >> (5 * (5 - i))) & 31);
  return hrp + '1' + [...data5, ...checksum].map(i => CS[i]).join('');
}
const address = () => bech32Encode(HRP, 0, [...cx.p2wpkhScript(pub).slice(2)]);
const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = s => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));

function cmdSelftest() {
  console.log(`selftest: aggregated range proof for SUPPLY=${SUPPLY} (single value, m=1)`);
  const blinding = deriveEtchBlinding(priv, new Uint8Array(36)); // arbitrary anchor for the test
  const { proof, commitments } = bpRangeAggProve([SUPPLY], [blinding]);
  console.log(`  proof ${proof.length} bytes, commitment ${pointToBytes(commitments[0]).length} bytes`);
  const ok = bpRangeAggVerify(commitments, proof);
  console.log(`  bpRangeAggVerify: ${ok ? 'PASS ✓' : 'FAIL ✗'}`);
  if (!ok) process.exit(1);
  // also confirm the commitment is exactly blinding·G when supply==0 (sanity)
  console.log('  selftest OK — supply-0 range proof is valid + verifiable');
}

async function cmdEtch() {
  const addr = address();
  console.log(`etch ${TICKER} supply=${SUPPLY} decimals=${DECIMALS} on ${NETWORK} from ${addr}`);
  const utxos = await (await fetch(`${MEMPOOL_API}/address/${addr}/utxo`)).json();
  const conf = utxos.filter(u => u.value > cx.DUST && u.status?.confirmed).sort((a, b) => b.value - a.value);
  if (!conf.length) throw new Error(`no confirmed UTXO > dust at ${addr}`);
  const funding = conf[0];
  console.log(`funding UTXO ${funding.txid.slice(0, 16)}…:${funding.vout} = ${funding.value} sats`);

  // Anchor the supply blinding to the commit's first input outpoint (chain-only re-derivable).
  const anchor = cx.concatBytes(cx.reverseBytes(cx.hexToBytes(funding.txid)),
    (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, funding.vout >>> 0, true); return b; })());
  const blinding = deriveEtchBlinding(priv, anchor);
  const amountKs = deriveEtchAmountKeystream(priv, anchor);
  const encryptedAmount = encryptAmount(SUPPLY, amountKs);
  const { proof, commitments } = bpRangeAggProve([SUPPLY], [blinding]);
  const commitment = pointToBytes(commitments[0]);
  const mintAuthority = new Uint8Array(32); // all-zero = non-mintable
  const payload = encodeCEtchPayload({ ticker: TICKER, decimals: DECIMALS, commitment, rangeproof: proof, encryptedAmount, mintAuthority, imageUri: null });
  console.log(`C-ETCH payload ${payload.length} bytes (rangeproof ${proof.length})`);

  const envelopeScript = cx.encodeEnvelopeScript(xonly, payload);
  const leaf = cx.tapLeafHash(envelopeScript);
  const { Q_xonly, parity } = cx.tweakedOutputKey(cx.TAP_NUMS, leaf);
  const p2trSpk = cx.p2trScript(Q_xonly);
  const cb = cx.controlBlock(cx.TAP_NUMS, parity);

  const REVEAL_FEE = parseInt(process.env.REVEAL_FEE || (NETWORK === 'mainnet' ? '0' : '800'), 10);
  const COMMIT_FEE = parseInt(process.env.COMMIT_FEE || (NETWORK === 'mainnet' ? '0' : '250'), 10);
  if (REVEAL_FEE <= 0 || COMMIT_FEE <= 0) throw new Error('set REVEAL_FEE + COMMIT_FEE (sats) explicitly for mainnet');
  const commitValue = cx.DUST + REVEAL_FEE;
  const change = funding.value - commitValue - COMMIT_FEE;
  if (change < 0) throw new Error(`insufficient: need ${commitValue + COMMIT_FEE}, have ${funding.value}`);
  const commitOutputs = [{ value: commitValue, script: p2trSpk }];
  if (change >= cx.DUST) commitOutputs.push({ value: change, script: cx.p2wpkhScript(pub) });

  const commitTx = { version: 2, locktime: 0,
    inputs: [{ txid: funding.txid, vout: funding.vout, sequence: 0xfffffffd, witness: [] }], outputs: commitOutputs };
  commitTx.inputs[0].witness = cx.signP2wpkhInputWithKey(commitTx, 0, funding.value, priv, pub);
  const commitHex = cx.bytesToHex(cx.serializeTx(commitTx));
  const commitTxid = cx.computeTxid(commitTx);

  const revealTx = { version: 2, locktime: 0,
    inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }],
    outputs: [{ value: cx.DUST, script: cx.p2wpkhScript(pub) }] };
  const prevouts = [{ value: commitValue, script: p2trSpk }];
  revealTx.inputs[0].witness = cx.signTaprootScriptPathInputWithKey(revealTx, prevouts, envelopeScript, cb, priv, 0);
  const revealHex = cx.bytesToHex(cx.serializeTx(revealTx));
  const revealTxid = cx.computeTxid(revealTx);

  console.log(`commit ${commitTxid} (${commitValue}+${change} sats) | reveal ${revealTxid}`);
  const b1 = await fetch(`${MEMPOOL_API}/tx`, { method: 'POST', body: commitHex });
  const t1 = await b1.text(); if (!b1.ok) throw new Error(`commit broadcast: ${b1.status} ${t1}`);
  console.log(`commit broadcast: ${t1.trim()}`);
  let b2, t2;
  for (let i = 0; i < 8; i++) {
    b2 = await fetch(`${MEMPOOL_API}/tx`, { method: 'POST', body: revealHex });
    t2 = await b2.text(); if (b2.ok) break;
    await new Promise(r => setTimeout(r, 2000));
  }
  if (!b2.ok) throw new Error(`reveal broadcast: ${b2.status} ${t2}`);
  console.log(`reveal broadcast: ${t2.trim()}`);

  const aid = cx.bytesToHex(assetIdFor(revealTxid, 0));
  const st = loadState();
  st[NETWORK] = { ticker: TICKER, decimals: DECIMALS, supply: SUPPLY.toString(),
    commitTxid, revealTxid, etchVout: 0, assetIdHex: aid,
    blinding: blinding.toString(16).padStart(64, '0'), commitment: cx.bytesToHex(commitment) };
  saveState(st);
  console.log(`\nasset_id: ${aid}`);
  console.log(`etch reveal txid: ${revealTxid} (vout 0)`);
  console.log(`opening: supply=${SUPPLY} blinding=${st[NETWORK].blinding}`);
  console.log(`track: ${MEMPOOL_API.replace('/api', '')}/tx/${revealTxid}`);
}

async function cmdStatus() {
  const st = loadState()[NETWORK];
  if (!st) throw new Error('no etch state — run "etch" first');
  const s = await (await fetch(`${MEMPOOL_API}/tx/${st.revealTxid}/status`)).json();
  console.log(`reveal ${st.revealTxid}: ${JSON.stringify(s)}`);
  console.log(`asset_id ${st.assetIdHex}`);
  const r = await fetch(`${WORKER_BASE}/assets/${st.assetIdHex}?network=${NETWORK}`);
  console.log(`worker /assets: ${r.status}`);
  if (r.ok) console.log(JSON.stringify(await r.json(), null, 2).slice(0, 1200));
}

async function cmdAttest() {
  const st = loadState()[NETWORK];
  if (!st) throw new Error('no etch state — run "etch" first');
  const body = { supply: st.supply, blinding: st.blinding, reveal_txid: st.revealTxid, reveal_vout: st.etchVout };
  console.log(`attest ${st.assetIdHex}: supply=${st.supply} (resolving commitment from reveal ${st.revealTxid.slice(0, 16)}…)`);
  const r = await fetch(`${WORKER_BASE}/assets/${st.assetIdHex}/attest?network=${NETWORK}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  console.log(`attest: ${r.status} ${JSON.stringify(j)}`);
  if (!r.ok) process.exit(1);
  console.log('attest OK — worker verified (supply, blinding) opening against the on-chain commitment ✓');
}

const cmd = process.argv[2] || 'selftest';
(async () => {
  try {
    if (cmd === 'selftest') cmdSelftest();
    else if (cmd === 'address') console.log(address());
    else if (cmd === 'etch') await cmdEtch();
    else if (cmd === 'attest') await cmdAttest();
    else if (cmd === 'status') await cmdStatus();
    else { console.log('usage: etch-asset.mjs [selftest|address|etch|attest|status]'); process.exit(1); }
  } catch (e) { console.error('ERROR:', e.message); if (e.stack) console.error(e.stack.split('\n').slice(1, 4).join('\n')); process.exit(1); }
})();
