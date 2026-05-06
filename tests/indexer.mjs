// Indexer state machine, mirrored from tacit.html.
//
// What's mirrored:
//   - encodeEnvelopeScript / decodeEnvelopeScript (outer Taproot tapscript)
//   - getParentEnvelopeData — resolves an input outpoint's parent into asset_id + commitment
//   - validateOutpoint — recursive ancestry validation across CETCH/MINT/CXFER/BURN
//
// Used by indexer.test.mjs to drive the recursive ancestry walker against
// synthesised Bitcoin txs (no network).

import * as secp from '@noble/secp256k1';
import { hexToBytes, bytesToHex, concatBytes } from '@noble/hashes/utils';
import { sha256 } from '@noble/hashes/sha256';
import {
  G, H, ZERO, modN,
  pedersenCommit, pointToBytes, bytesToPoint, bigintToBytes32, bytes32ToBigint,
  bpRangeAggVerify,
} from './bulletproofs.mjs';
import {
  N_BITS,
  T_CETCH, T_CXFER, T_MINT, T_BURN,
  reverseBytes, assetIdFor,
  decodeCEtchPayload, decodeCXferPayload, decodeCMintPayload, decodeCBurnPayload,
  computeKernelMsg, computeMintMsg,
  verifySchnorr,
  disclosureMsg,
} from './composition.mjs';
import { ripemd160 } from '@noble/hashes/ripemd160';

const hash160 = b => ripemd160(sha256(b));

const safeMult = (P, s) => { const x = modN(s); return x === 0n ? ZERO : P.multiply(x); };

// --- Envelope script (outer Taproot wrapping) ---
const ENVELOPE_MAGIC = new TextEncoder().encode('TACIT');
const ENVELOPE_VERSION = 0x01;
const MAX_SCRIPT_PUSH = 520;
const OP_FALSE = 0x00, OP_PUSHDATA1 = 0x4c, OP_PUSHDATA2 = 0x4d;
const OP_IF = 0x63, OP_ENDIF = 0x68, OP_CHECKSIG = 0xac;

function _encodePush(data) {
  if (data.length === 0) return new Uint8Array([OP_FALSE]);
  if (data.length <= 75) return concatBytes(new Uint8Array([data.length]), data);
  if (data.length <= 255) return concatBytes(new Uint8Array([OP_PUSHDATA1, data.length]), data);
  if (data.length <= 65535) {
    const lenLE = new Uint8Array(2); new DataView(lenLE.buffer).setUint16(0, data.length, true);
    return concatBytes(new Uint8Array([OP_PUSHDATA2]), lenLE, data);
  }
  throw new Error('push data too large');
}
function encodeEnvelopeScript(signingPubXonly, payload) {
  if (signingPubXonly.length !== 32) throw new Error('signing pubkey must be 32 bytes (x-only)');
  const chunks = [ENVELOPE_MAGIC, new Uint8Array([ENVELOPE_VERSION])];
  for (let i = 0; i < payload.length; i += MAX_SCRIPT_PUSH) {
    chunks.push(payload.slice(i, Math.min(i + MAX_SCRIPT_PUSH, payload.length)));
  }
  const pieces = [
    _encodePush(signingPubXonly),
    new Uint8Array([OP_CHECKSIG]),
    new Uint8Array([OP_FALSE, OP_IF]),
  ];
  for (const c of chunks) pieces.push(_encodePush(c));
  pieces.push(new Uint8Array([OP_ENDIF]));
  return concatBytes(...pieces);
}
function decodeEnvelopeScript(script) {
  if (!script || script.length < 36) return null;
  let p = 0;
  if (script[p] !== 32) return null; p += 1;
  if (p + 32 > script.length) return null;
  const signingPubXonly = script.slice(p, p + 32); p += 32;
  if (p + 1 > script.length || script[p] !== OP_CHECKSIG) return null; p += 1;
  if (p + 2 > script.length || script[p] !== OP_FALSE || script[p + 1] !== OP_IF) return null; p += 2;
  const pushes = [];
  let sawEndif = false;
  while (p < script.length) {
    if (script[p] === OP_ENDIF) { p += 1; sawEndif = true; break; }
    const op = script[p]; p += 1;
    let data;
    if (op >= 1 && op <= 75) {
      if (p + op > script.length) return null;
      data = script.slice(p, p + op); p += op;
    } else if (op === OP_PUSHDATA1) {
      if (p + 1 > script.length) return null;
      const ln = script[p]; p += 1;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    } else if (op === OP_PUSHDATA2) {
      if (p + 2 > script.length) return null;
      const ln = script[p] | (script[p + 1] << 8); p += 2;
      if (p + ln > script.length) return null;
      data = script.slice(p, p + ln); p += ln;
    } else if (op === OP_FALSE) { data = new Uint8Array(0); }
    else { return null; }
    pushes.push(data);
  }
  if (!sawEndif) return null;
  if (p !== script.length) return null;
  if (pushes.length < 3) return null;
  if (pushes[0].length !== ENVELOPE_MAGIC.length) return null;
  for (let i = 0; i < ENVELOPE_MAGIC.length; i++) if (pushes[0][i] !== ENVELOPE_MAGIC[i]) return null;
  if (pushes[1].length !== 1 || pushes[1][0] !== ENVELOPE_VERSION) return null;
  const payload = concatBytes(...pushes.slice(2));
  if (payload.length < 1) return null;
  return { signingPubXonly, opcode: payload[0], payload };
}

function getParentEnvelopeData(parentEnv, vout, parentTxid) {
  if (parentEnv.opcode === T_CETCH) {
    if (vout !== 0) return null;
    const d = decodeCEtchPayload(parentEnv.payload);
    if (!d) return null;
    return { assetIdHex: bytesToHex(assetIdFor(parentTxid, 0)), commitment: d.commitment };
  }
  if (parentEnv.opcode === T_MINT) {
    if (vout !== 0) return null;
    const d = decodeCMintPayload(parentEnv.payload);
    if (!d) return null;
    return { assetIdHex: bytesToHex(d.assetId), commitment: d.commitment };
  }
  if (parentEnv.opcode === T_CXFER) {
    const d = decodeCXferPayload(parentEnv.payload);
    if (!d || vout >= d.outputs.length) return null;
    return { assetIdHex: bytesToHex(d.assetId), commitment: d.outputs[vout].commitment };
  }
  if (parentEnv.opcode === T_BURN) {
    const d = decodeCBurnPayload(parentEnv.payload);
    if (!d || vout >= d.outputs.length) return null;
    return { assetIdHex: bytesToHex(d.assetId), commitment: d.outputs[vout].commitment };
  }
  return null;
}

// Recursive ancestry validator, mirrored from tacit.html.
// fetchTx: async (txidHex) => { vin: [{ txid, vout, witness: [hex...] }, ...] } | null
async function validateOutpoint(txidHex, vout, validatedSet, fetchTx, depth = 0, metadataOut = null, rpBatch = null) {
  const key = `${txidHex}:${vout}`;
  if (validatedSet.has(key)) return validatedSet.get(key);
  if (depth > 200) { validatedSet.set(key, false); return false; }

  const tx = await fetchTx(txidHex);
  if (!tx || !tx.vin || !tx.vin[0]) { validatedSet.set(key, false); return false; }
  const wit = tx.vin[0].witness;
  if (!wit || wit.length < 3) { validatedSet.set(key, false); return false; }
  let env;
  try { env = decodeEnvelopeScript(hexToBytes(wit[1])); } catch { env = null; }
  if (!env) { validatedSet.set(key, false); return false; }

  const markAll = (n, ok) => { for (let j = 0; j < n; j++) validatedSet.set(`${txidHex}:${j}`, ok); };

  if (env.opcode === T_CETCH) {
    if (vout !== 0) { validatedSet.set(key, false); return false; }
    const dec = decodeCEtchPayload(env.payload);
    if (!dec) { validatedSet.set(key, false); return false; }
    let Cpt; try { Cpt = bytesToPoint(dec.commitment); } catch { validatedSet.set(key, false); return false; }
    if (rpBatch) {
      rpBatch.push({ commitments: [Cpt], proof: dec.rangeproof });
      validatedSet.set(key, true);
    } else {
      const ok = bpRangeAggVerify([Cpt], dec.rangeproof);
      validatedSet.set(key, ok);
      if (!ok) return false;
    }
    if (metadataOut) {
      const aidHex = bytesToHex(assetIdFor(txidHex, 0));
      if (!metadataOut.has(aidHex)) {
        metadataOut.set(aidHex, {
          ticker: dec.ticker, decimals: dec.decimals, etchTxid: txidHex,
          imageUri: dec.imageUri || null,
          mintable: dec.mintable, mintAuthorityHex: bytesToHex(dec.mintAuthority),
        });
      }
    }
    return true;
  }

  if (env.opcode === T_MINT) {
    if (vout !== 0) { validatedSet.set(key, false); return false; }
    const dec = decodeCMintPayload(env.payload);
    if (!dec) { validatedSet.set(key, false); return false; }
    const aidFromEtch = assetIdFor(bytesToHex(dec.etchTxid), 0);
    for (let i = 0; i < 32; i++) if (aidFromEtch[i] !== dec.assetId[i]) { validatedSet.set(key, false); return false; }
    const etchTxidHex = bytesToHex(dec.etchTxid);
    const etchTx = await fetchTx(etchTxidHex);
    if (!etchTx?.vin?.[0]?.witness || etchTx.vin[0].witness.length < 3) { validatedSet.set(key, false); return false; }
    let etchEnv;
    try { etchEnv = decodeEnvelopeScript(hexToBytes(etchTx.vin[0].witness[1])); } catch { etchEnv = null; }
    if (!etchEnv || etchEnv.opcode !== T_CETCH) { validatedSet.set(key, false); return false; }
    const etchDec = decodeCEtchPayload(etchEnv.payload);
    if (!etchDec || !etchDec.mintable) { validatedSet.set(key, false); return false; }
    // SPEC §5.3 anchor binding: re-derive commit_anchor from the mint reveal's
    // parent commit tx so the issuer sig can't be replayed into a different
    // (commit, reveal) pair.
    const mintCommitTx = await fetchTx(tx.vin[0].txid);
    if (!mintCommitTx?.vin?.[0]) { validatedSet.set(key, false); return false; }
    const ci = mintCommitTx.vin[0];
    const mintAnchor = concatBytes(
      reverseBytes(hexToBytes(ci.txid)),
      (() => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, ci.vout >>> 0, true); return b; })(),
    );
    const mintMsg = computeMintMsg(dec.assetId, mintAnchor, dec.commitment, dec.encryptedAmount);
    if (!verifySchnorr(dec.issuerSig, mintMsg, etchDec.mintAuthority)) { validatedSet.set(key, false); return false; }
    let Cpt; try { Cpt = bytesToPoint(dec.commitment); } catch { validatedSet.set(key, false); return false; }
    if (rpBatch) {
      rpBatch.push({ commitments: [Cpt], proof: dec.rangeproof });
      validatedSet.set(key, true);
    } else {
      const ok = bpRangeAggVerify([Cpt], dec.rangeproof);
      validatedSet.set(key, ok);
      if (!ok) return false;
    }
    if (metadataOut) {
      const aidHex = bytesToHex(dec.assetId);
      if (!metadataOut.has(aidHex)) {
        metadataOut.set(aidHex, {
          ticker: etchDec.ticker, decimals: etchDec.decimals, etchTxid: etchTxidHex,
          imageUri: etchDec.imageUri || null,
          mintable: etchDec.mintable, mintAuthorityHex: bytesToHex(etchDec.mintAuthority),
        });
      }
    }
    return true;
  }

  if (env.opcode === T_CXFER || env.opcode === T_BURN) {
    const isBurn = env.opcode === T_BURN;
    const dec = isBurn ? decodeCBurnPayload(env.payload) : decodeCXferPayload(env.payload);
    if (!dec) { validatedSet.set(key, false); return false; }
    const N = dec.outputs.length;
    if (!isBurn && vout >= N) { validatedSet.set(key, false); return false; }
    if (isBurn && N > 0 && vout >= N) { validatedSet.set(key, false); return false; }

    if (tx.vin.length < 2) { markAll(Math.max(N, 1), false); return false; }
    for (let i = 1; i < tx.vin.length; i++) {
      const inp = tx.vin[i];
      const parentValid = await validateOutpoint(inp.txid, inp.vout, validatedSet, fetchTx, depth + 1, metadataOut, rpBatch);
      if (!parentValid) { markAll(Math.max(N, 1), false); return false; }
    }

    let Cpts;
    if (N > 0) {
      try { Cpts = dec.outputs.map(o => bytesToPoint(o.commitment)); }
      catch { markAll(Math.max(N, 1), false); return false; }
      if (rpBatch) {
        rpBatch.push({ commitments: Cpts, proof: dec.rangeproof });
      } else {
        if (!bpRangeAggVerify(Cpts, dec.rangeproof)) { markAll(Math.max(N, 1), false); return false; }
      }
    } else {
      Cpts = [];
    }

    const ourAssetIdHex = bytesToHex(dec.assetId);
    const inputCommitments = [];
    for (let i = 1; i < tx.vin.length; i++) {
      const inp = tx.vin[i];
      const parent = await fetchTx(inp.txid);
      const pwit = parent?.vin?.[0]?.witness;
      if (!pwit || pwit.length < 3) { markAll(Math.max(N, 1), false); return false; }
      let parentEnv;
      try { parentEnv = decodeEnvelopeScript(hexToBytes(pwit[1])); } catch { parentEnv = null; }
      if (!parentEnv) { markAll(Math.max(N, 1), false); return false; }
      const pd = getParentEnvelopeData(parentEnv, inp.vout, inp.txid);
      if (!pd) { markAll(Math.max(N, 1), false); return false; }
      if (pd.assetIdHex !== ourAssetIdHex) { markAll(Math.max(N, 1), false); return false; }
      inputCommitments.push(pd.commitment);
    }

    let EPrime = ZERO;
    try {
      for (const o of dec.outputs) EPrime = EPrime.add(bytesToPoint(o.commitment));
      if (isBurn && dec.burnedAmount > 0n) EPrime = EPrime.add(safeMult(H, dec.burnedAmount));
      for (const c of inputCommitments) EPrime = EPrime.add(bytesToPoint(c).negate());
    } catch { markAll(Math.max(N, 1), false); return false; }
    if (EPrime.equals(ZERO)) { markAll(Math.max(N, 1), false); return false; }

    const ExBytes = EPrime.toRawBytes(true).slice(1);
    const inputOutpoints = tx.vin.slice(1).map(v => ({ txid: v.txid, vout: v.vout }));
    const outputCommitments = dec.outputs.map(o => o.commitment);
    const burnedAmount = isBurn ? dec.burnedAmount : 0n;
    const msg = computeKernelMsg(dec.assetId, inputOutpoints, outputCommitments, burnedAmount);
    const kernelOk = verifySchnorr(dec.kernelSig, msg, ExBytes);

    markAll(Math.max(N, 1), kernelOk);
    return kernelOk;
  }

  validatedSet.set(key, false);
  return false;
}

// Consumer-side disclosure verifier (SPEC §5.6 verifier requirements 1–4).
// Mirror of dapp/tacit.js::verifyDisclosure. Tested in disclosure.test.mjs.
//
// Returns { ok: true } or { ok: false, reason }. fail-closed on internal throw.
// fetchTx is async (txid) => parent-tx (mempool.space shape) — same contract as
// validateOutpoint's.
async function verifyDisclosure(disclosure, fetchTx) {
  try {
    const assetIdHex   = String(disclosure.asset_id   || '').toLowerCase();
    const ownerPubHex  = String(disclosure.owner_pubkey || '').toLowerCase();
    const sigHex       = String(disclosure.sig || '').toLowerCase();
    const rangeproofHex = String(disclosure.rangeproof || '').toLowerCase();
    const thresholdStr = String(disclosure.threshold ?? '');
    const utxosRaw     = Array.isArray(disclosure.utxos) ? disclosure.utxos : null;

    if (!/^[0-9a-f]{64}$/.test(assetIdHex))         return { ok: false, reason: 'asset_id malformed' };
    if (!/^0[23][0-9a-f]{64}$/.test(ownerPubHex))   return { ok: false, reason: 'owner_pubkey malformed' };
    if (!/^[0-9a-f]{128}$/.test(sigHex))            return { ok: false, reason: 'sig malformed' };
    if (!/^[0-9a-f]+$/.test(rangeproofHex) || rangeproofHex.length % 2) return { ok: false, reason: 'rangeproof not hex' };
    if (!/^\d+$/.test(thresholdStr))                return { ok: false, reason: 'threshold malformed' };
    if (!utxosRaw || !utxosRaw.length || utxosRaw.length > 64) return { ok: false, reason: 'utxos count out of range (1..64)' };

    const K = BigInt(thresholdStr);
    if (K <= 0n || K >= (1n << BigInt(N_BITS))) return { ok: false, reason: 'threshold out of (0, 2^64)' };

    const ownerPubBytes = hexToBytes(ownerPubHex);
    const expectHash160 = bytesToHex(hash160(ownerPubBytes));
    const utxos = [];
    let Csum = ZERO;
    for (const u of utxosRaw) {
      const txidHex = String(u?.txid || '').toLowerCase();
      const vout    = u?.vout;
      if (!/^[0-9a-f]{64}$/.test(txidHex)) return { ok: false, reason: 'utxo.txid malformed' };
      if (!Number.isInteger(vout) || vout < 0 || vout > 0xffff) return { ok: false, reason: 'utxo.vout out of range' };
      utxos.push({ txid: txidHex, vout });

      const tx = await fetchTx(txidHex);
      if (!tx?.vout?.[vout]?.scriptpubkey) return { ok: false, reason: `utxo ${txidHex}:${vout}: scriptpubkey missing` };
      const spk = hexToBytes(tx.vout[vout].scriptpubkey);
      if (spk.length !== 22 || spk[0] !== 0x00 || spk[1] !== 0x14) {
        return { ok: false, reason: `utxo ${txidHex}:${vout}: not P2WPKH` };
      }
      if (bytesToHex(spk.slice(2, 22)) !== expectHash160) {
        return { ok: false, reason: `utxo ${txidHex}:${vout}: owner_pubkey does not control this UTXO` };
      }

      const parentWitness = tx?.vin?.[0]?.witness;
      if (!parentWitness || parentWitness.length < 3) return { ok: false, reason: `utxo ${txidHex}:${vout}: parent has no envelope witness` };
      let parentEnv;
      try { parentEnv = decodeEnvelopeScript(hexToBytes(parentWitness[1])); } catch { parentEnv = null; }
      if (!parentEnv) return { ok: false, reason: `utxo ${txidHex}:${vout}: parent envelope decode failed` };
      const pd = getParentEnvelopeData(parentEnv, vout, txidHex);
      if (!pd) return { ok: false, reason: `utxo ${txidHex}:${vout}: parent envelope yields no commitment for vout` };
      if (pd.assetIdHex !== assetIdHex) return { ok: false, reason: `utxo ${txidHex}:${vout}: asset_id mismatch (parent=${pd.assetIdHex})` };

      let Ci;
      try { Ci = bytesToPoint(pd.commitment); } catch { return { ok: false, reason: `utxo ${txidHex}:${vout}: commitment unparseable` }; }
      Csum = Csum.add(Ci);
    }

    const rangeproofBytes = hexToBytes(rangeproofHex);

    const msg = disclosureMsg(hexToBytes(assetIdHex), utxos, K, rangeproofBytes, ownerPubBytes);
    if (!verifySchnorr(hexToBytes(sigHex), msg, ownerPubBytes.slice(1))) {
      return { ok: false, reason: 'Schnorr sig invalid' };
    }

    const Cprime = Csum.add(safeMult(H, K).negate());
    if (!bpRangeAggVerify([Cprime], rangeproofBytes)) {
      return { ok: false, reason: 'rangeproof does not verify against C_sum − K·H' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'verifyDisclosure threw: ' + (e?.message || e) };
  }
}

export {
  encodeEnvelopeScript, decodeEnvelopeScript,
  getParentEnvelopeData, validateOutpoint,
  verifyDisclosure,
};
