// Builds the Bitcoin-side commit/reveal pair that mints a recorded ETH->BTC cross-out as a Bitcoin note
// (T_CROSSOUT_MINT, opcode 0x65). Mirrors burn-deposit's own commit/reveal shape, but the reveal has no note
// input -- the note is MINTED by the envelope, not spent. Extracted from tools/build-crossout-mint.mjs, the
// script that built the commit `f6e3d75a3b238086...` / reveal `3405ffbee20e9f14914954e071cbba6ae9bc82588fd6cf6f28a7d4b140b77490`
// proving this end to end on mainnet -- same math, same self-checks, taking prims by injection instead of a
// one-shot script's monkey-patched module singleton.
//
// The reveal's vout 0 MUST be a P2TR output paying the exact x-only key the crossOut named as its destOwner --
// the reflection guest reads the destination authority from that output (output_p2tr_xonly(tx, 0)), not from
// the envelope's own carrier key. A mint whose vout 0 is not P2TR(destXonly) folds nothing and consumes no
// claim, and the reflection scan does not surface that as an error -- both the key and the serialized output
// are self-checked below before anything is signed.
import { encodeCrossoutMint } from './confidential-crossout-consumer.js';

// Measured on real signed transactions: the commit is 153 vB with a change output, the reveal 172 vB. The budgets are those, rounded up.
const REVEAL_VB = 180, COMMIT_VB = 154;
const MIN_RELAY_RATE = 1;                                     // sat/vB, the floor a node relays at

// Virtual size of a serialized segwit transaction, read from its bytes.
export function vsizeOfHex(hex) {
  const b = hexBytes(hex); let p = 4;
  const seg = b[p] === 0 && b[p + 1] === 1; if (seg) p += 2;
  const vi = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b[p] | (b[p + 1] << 8); p += 2; return v; } const v = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; p += 4; return v; };
  const nin = vi(); for (let i = 0; i < nin; i++) { p += 36; const l = vi(); p += l + 4; }
  const nout = vi(); for (let i = 0; i < nout; i++) { p += 8; const l = vi(); p += l; }
  const wStart = p;
  if (seg) for (let i = 0; i < nin; i++) { const n = vi(); for (let j = 0; j < n; j++) { const l = vi(); p += l; } }
  const wit = seg ? (p - wStart) + 2 : 0, base = b.length - wit;
  return Math.ceil((base * 3 + b.length) / 4);
}
function hexBytes(h) { const s = String(h).replace(/^0x/, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; }

export function makeCrossoutMintReveal({ secp } = {}) {
  if (!secp) throw new Error('crossout-mint-reveal: deps.secp required');

  // prims: makeBtcWallet(...).prims. destXonly: the x-only key crossOut() named as destOwner (32 bytes hex,
  // 0x-optional). fundingUtxo: one plain P2WPKH UTXO owned by prims.wallet, funding both transactions.
  function buildCrossoutMintTxs({ prims, assetId, claimId, cx, cy, destXonly, fundingUtxo, feeRate }) {
    const destHex = String(destXonly).replace(/^0x/, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(destHex) || /^0{64}$/.test(destHex)) {
      throw new Error('crossout-mint-reveal: destXonly must be 32 non-zero bytes');
    }
    try { secp.ProjectivePoint.fromHex('02' + destHex); }
    catch { throw new Error('crossout-mint-reveal: destXonly is not a valid secp256k1 x-coordinate'); }

    // owner is carried for wire compatibility but the guest does not read it -- destination authority comes
    // from the reveal's vout 0, built below.
    const payload = encodeCrossoutMint({ assetId, claimId, cx, cy, owner: '0x' + '00'.repeat(32) });
    if (payload.length !== 161) throw new Error(`crossout-mint-reveal: payload length ${payload.length}, expected 161`);

    const envelopeScript = prims.encodeEnvelopeScript(prims.wallet.xonly(), payload);
    const leaf = prims.tapLeafHash(envelopeScript);
    const { Q_xonly, parity } = prims.tweakedOutputKey(prims.TAP_NUMS, leaf);
    const p2trSpk = prims.p2trScript(Q_xonly);
    const cb = prims.controlBlock(prims.TAP_NUMS, parity);
    const senderP2wpkh = prims.p2wpkhScript(prims.wallet.pub);
    const destSpk = prims.hexToBytes('5120' + destHex);

    const rate = Math.max(MIN_RELAY_RATE, Number(feeRate) || 3);
    const revealFee = Math.ceil(REVEAL_VB * rate);
    const commitValue = revealFee + prims.DUST;
    const commitFee = Math.ceil(COMMIT_VB * rate);
    const commitChange = fundingUtxo.value - commitValue - commitFee;
    if (commitChange < 0) {
      throw new Error(`crossout-mint-reveal: funding UTXO too small -- need ${commitValue + commitFee}, have ${fundingUtxo.value}`);
    }
    const commitOutputs = [{ value: commitValue, script: p2trSpk }];
    if (commitChange >= 294) commitOutputs.push({ value: commitChange, script: senderP2wpkh });

    const commitTx = { version: 2, locktime: 0, inputs: [{ txid: fundingUtxo.txid, vout: fundingUtxo.vout, sequence: 0xfffffffd, witness: [] }], outputs: commitOutputs };
    commitTx.inputs[0].witness = prims.signP2wpkhInput(commitTx, 0, fundingUtxo.value);
    const commitHex = prims.bytesToHex(prims.serializeTx(commitTx));
    const commitTxid = prims.txid(commitTx);

    const revealTx = { version: 2, locktime: 0, inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs: [{ value: prims.DUST, script: destSpk }] };
    const prevouts = [{ value: commitValue, script: p2trSpk }];
    revealTx.inputs[0].witness = prims.signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
    const revealHex = prims.bytesToHex(prims.serializeTx(revealTx));
    const revealTxid = prims.txid(revealTx);

    // Self-check on the serialized bytes, not just the object we built them from: the reveal must carry
    // exactly one output, and it must be the P2TR script for destXonly (0x22 push-length, 0x51 0x20 = OP_1
    // PUSH32) -- the one property whose violation is invisible on-chain until the fold silently no-ops.
    if (!revealHex.includes('225120' + destHex)) throw new Error('crossout-mint-reveal: self-check failed -- reveal vout 0 is not P2TR(destXonly)');
    if (revealTx.outputs.length !== 1) throw new Error('crossout-mint-reveal: self-check failed -- reveal must have exactly one output');

    // Each transaction must pay at least the relay floor for what it measures: a node refuses one that does not, and the refusal is final.
    const commitIn = fundingUtxo.value, commitOut = commitOutputs.reduce((n, o) => n + o.value, 0);
    if (commitIn - commitOut < vsizeOfHex(commitHex) * MIN_RELAY_RATE) throw new Error('crossout-mint-reveal: the commit would pay under the minimum relay fee');
    if (commitValue - prims.DUST < vsizeOfHex(revealHex) * MIN_RELAY_RATE) throw new Error('crossout-mint-reveal: the reveal would pay under the minimum relay fee');
    return { commitHex, commitTxid, revealHex, revealTxid, feeRate: rate, commitFee, revealFee, commitValue };
  }

  // What one mint costs the wallet that pays for it: both transactions' fees at `feeRate`, plus the dust the note's own
  // output holds. The same arithmetic as buildCrossoutMintTxs, for a caller that needs the figure before it signs.
  function estimateSats({ feeRate, dust }) {
    const rate = Number(feeRate) || 3;
    return Math.ceil(REVEAL_VB * rate) + dust + Math.ceil(COMMIT_VB * rate);
  }

  return { buildCrossoutMintTxs, estimateSats };
}
