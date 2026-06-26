// T_CROSSOUT_MINT (0x65) signet broadcaster — the ETH→BTC reverse-bridge Bitcoin-side mint.
//
// After a confidential-pool bridge_burn records crossOutCommitment[claimId]=destCommitment on Ethereum,
// this broadcasts the matching 0x65 envelope on Bitcoin: a Taproot commit/reveal carrying the 161-byte
// encodeCrossoutMint payload (assetId, claimId, cx, cy, owner). The minted note leaf
// keccak(asset‖Cx‖Cy‖owner) MUST equal the recorded destCommitment. The reflection guest's fold_crossout
// (eth-crossOutSet-gated) is the trustless authority; this tx just materializes the Bitcoin-side note so
// reflection can fold it. Reuses the dapp's commit-reveal envelope path (same as a bridge deposit), minus
// asset-carving — a 0x65 carries no asset input, just the envelope + a dust mint-anchor output.
//
// Env: NETWORK(signet) ASSET_ID CLAIM_ID CX CY OWNER (all 64-hex; OWNER optional, default 0). DRY_RUN=1
//      builds + prints hex without broadcasting. Wallet: ~/.tacit-validation/signet.json {priv_hex,network}.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { concatBytes, hexToBytes, bytesToHex } from '@noble/hashes/utils';
import * as secp from '@noble/secp256k1';
import { encodeCrossoutMint } from '../dapp/confidential-crossout-consumer.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
globalThis.window = dom.window; globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage; globalThis.location = dom.window.location;
globalThis.navigator = dom.window.navigator;
if (!globalThis.crypto) { try { globalThis.crypto = dom.window.crypto; } catch {} }
globalThis.prompt = () => null; globalThis.alert = () => {}; globalThis.confirm = () => false;
globalThis.__TACIT_NO_INIT__ = true;

const NETWORK = (process.env.NETWORK || 'signet').toLowerCase();
if (NETWORK !== 'signet' && NETWORK !== 'mainnet') { console.error('✗ NETWORK must be signet|mainnet'); process.exit(1); }
globalThis.localStorage.setItem('tacit-network-v1', NETWORK);
const envHex = (n, opt = false) => {
  const v = process.env[n];
  if (!v) { if (opt) return '0x' + '00'.repeat(32); console.error(`✗ ${n} required (64-hex)`); process.exit(1); }
  const h = v.replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) { console.error(`✗ ${n} must be 64-hex`); process.exit(1); }
  return '0x' + h.toLowerCase();
};
const ASSET_ID = envHex('ASSET_ID'), CLAIM_ID = envHex('CLAIM_ID'), CX = envHex('CX'), CY = envHex('CY'), OWNER = envHex('OWNER', true);

const dapp = await import('../dapp/tacit.js');
const walletFile = path.join(os.homedir(), '.tacit-validation', 'signet.json');
const w = JSON.parse(readFileSync(walletFile, 'utf8'));
if (!/^[0-9a-f]{64}$/i.test(w.priv_hex || '')) { console.error('✗ signet.json priv_hex must be 64-hex'); process.exit(1); }
const PRIV = hexToBytes(w.priv_hex);
const PUB = secp.getPublicKey(PRIV, true); // 33-byte compressed
dapp.wallet.priv = PRIV;
dapp.wallet.pub = PUB;
dapp.invalidateHoldingsCache?.();
const addr = dapp.wallet.address();
console.log(`network: ${NETWORK}  wallet: ${addr}`);
if (w.address && w.address !== addr) console.log(`  (note: signet.json address ${w.address} != derived ${addr})`);

// ---- payload + envelope ----
const payload = encodeCrossoutMint({ assetId: ASSET_ID, claimId: CLAIM_ID, cx: CX, cy: CY, owner: OWNER });
console.log(`✓ 0x65 payload (${payload.length} bytes)  leaf=keccak(asset‖cx‖cy‖owner) must == destCommitment`);
const PUBK = dapp.wallet.pub;
const envelopeScript = dapp.encodeEnvelopeScript(dapp.wallet.xonly(), payload);
const tapLeaf = dapp.tapLeafHash(envelopeScript);
const TAP_NUMS = hexToBytes('50929b74c1a04954b78b4b6035e97a5e078a5a0f28ec96d547bfee9ace803ac0');
const { Q_xonly, parity } = dapp.tweakedOutputKey(TAP_NUMS, tapLeaf);
const commitSpk = dapp.p2trScript(Q_xonly);
const cb = dapp.controlBlock(TAP_NUMS, parity);
const wpkhSpk = concatBytes(new Uint8Array([0x00, 0x14]), dapp.hash160(PUBK));
const DUST = 546;

// reveal: input[0]=commit (script-path envelope) → output[0]=DUST mint-anchor to wallet. commit funds it.
const revealVb = 11 + 41 + 31 + Math.ceil((1 + 1 + 65 + 3 + 45 + payload.length + 34) / 4);
const feeRate = await dapp.getFeeRate();
const revealFee = dapp.feeFor(revealVb, feeRate);
const commitValue = DUST + revealFee;
console.log(`  revealVb≈${revealVb} feeRate=${feeRate} revealFee=${revealFee} commitValue=${commitValue}`);

// ---- fund + build commit ----
const allUtxos = await dapp.getUtxos(addr);
const sats = allUtxos.filter(u => u.value > DUST).sort((a, b) => b.value - a.value);
if (!sats.length) { console.error('✗ no sats UTXOs to fund the 0x65 commit'); process.exit(1); }
const picked = []; let total = 0; let commitFee = 300;
for (const u of sats) { picked.push(u); total += u.value; commitFee = dapp.feeFor(dapp.estCommitVb(picked.length), feeRate); if (total >= commitValue + commitFee + DUST) break; }
if (total < commitValue + commitFee) { console.error(`✗ insufficient sats: need ${commitValue + commitFee}, have ${total}`); process.exit(1); }
const satsChange = total - commitValue - commitFee;
const commitOutputs = [{ value: commitValue, script: commitSpk }];
if (satsChange >= DUST) commitOutputs.push({ value: satsChange, script: wpkhSpk });
const commitTx = { version: 2, locktime: 0, inputs: picked.map(u => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })), outputs: commitOutputs };
for (let i = 0; i < commitTx.inputs.length; i++) commitTx.inputs[i].witness = dapp.signP2wpkhInput(commitTx, i, picked[i].value);
const commitHex = bytesToHex(dapp.serializeTx(commitTx));
const commitTxid = dapp.txid(commitTx);
console.log(`✓ commit ${commitTxid.slice(0, 16)}… (${picked.length} inputs, ${total} sats)`);

// ---- build reveal ----
const revealTx = { version: 2, locktime: 0, inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: DUST, script: wpkhSpk }] };
revealTx.inputs[0].witness = dapp.signTaprootScriptPathInput(revealTx, [{ value: commitValue, script: commitSpk }], envelopeScript, cb);
const revealHex = bytesToHex(dapp.serializeTx(revealTx));
const revealTxid = dapp.txid(revealTx);
console.log(`✓ reveal ${revealTxid.slice(0, 16)}… → mint anchor at ${revealTxid.slice(0, 16)}…:0`);

if (process.env.DRY_RUN === '1') {
  console.log('DRY_RUN=1: not broadcasting');
  console.log('commit:', commitHex);
  console.log('reveal:', revealHex);
} else {
  console.log('broadcasting commit…'); await dapp.broadcast(commitHex);
  console.log('broadcasting reveal…'); await dapp.broadcastWithRetry(revealHex);
  console.log('✓ broadcast');
}
console.log(`\n=== T_CROSSOUT_MINT broadcast ===`);
console.log(`  claimId:     ${CLAIM_ID}`);
console.log(`  reveal txid: ${revealTxid}  vout 0`);
console.log(`  the reflection fold_crossout (eth-crossOutSet-gated) folds this into bitcoinPoolRoot after ${NETWORK==='signet'?6:6}+ confs`);
