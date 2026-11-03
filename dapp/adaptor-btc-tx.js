// The Bitcoin transactions of a cross-chain adaptor swap, built and signed but not sent: the lock (a transfer whose
// payload output is the Taproot lock of dapp/adaptor-btc-lock.js), the claim (a key-path spend of the lock with
// d_claimer + t) and the refund (a script-path spend once the timelock has run). Each is a Tacit transfer, so each is
// a commit/reveal pair built the way the wallet builds one (tacit.js buildAndBroadcastCXferMulti): the same kernel,
// payload, envelope, output padding, commit funding and change, with a custom output script and custom input
// signers. Outputs to the wallet itself use the wallet's own change blinding and amount keystream, so the wallet
// finds them again by scanning like any other note of its own.
//
// Pure: no network, no storage. The wallet's primitives (dapp/bitcoin-taproot-wallet.js `prims`) and Tacit's
// transfer codec (tacitKit) come in as arguments. A caller stores `commitHex` and `revealHex` before it sends
// either, and sends them with broadcastPair, so a restart between the two sends resumes with the reveal.

import { concatBytes, hexToBytes, bytesToHex } from './vendor/tacit-deps.min.js';
import { modN, bigintToBytes32, pointToBytes, signSchnorr, verifySchnorr } from './bulletproofs.js';
import { bppRangeProve } from './bulletproofs-plus.js';

const SEQ = 0xfffffffd;
const u32le = (n) => Uint8Array.of(n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff);
const reverse = (b) => Uint8Array.from(b).reverse();
const asBig = (x) => (typeof x === 'bigint' ? x : BigInt(x));
const priv32 = (d) => (d instanceof Uint8Array ? d : bigintToBytes32(asBig(d)));

// Tacit's transfer codec from the dapp's tacit.js namespace (the browser's `T`, or worker-relay's loadTacit). The
// default range proof and payload are Bulletproofs+, the wallet's default; pass the classic pair to build T_CXFER.
export function tacitKit(tacit, { rangeProve = bppRangeProve, encodePayload = tacit.encodeCXferBppPayload } = {}) {
  return {
    computeKernelMsg: tacit.computeKernelMsg,
    rangeProve,
    encodePayload,
    deriveChangeBlinding: tacit.deriveChangeBlinding,
    deriveAmountKeystreamSelf: tacit.deriveAmountKeystreamSelf,
    encryptAmount: tacit.encryptAmount,
  };
}

export function makeAdaptorBtcTx({ prims, kit }) {
  const { wallet, DUST } = prims;
  const own = prims.p2wpkhScript(wallet.pub);
  const anchorOf = (input) => concatBytes(reverse(hexToBytes(input.txid)), u32le(input.vout));
  const vsizeOf = (tx) => Math.ceil((prims.serializeTx(tx, false).length * 3 + prims.serializeTx(tx, true).length) / 4);
  const selfOut = (anchor, idx, amount) => ({
    amount: asBig(amount), script: own,
    blinding: kit.deriveChangeBlinding(wallet.priv, anchor, idx),
    keystream: kit.deriveAmountKeystreamSelf(wallet.priv, anchor, idx),
  });

  // inputs:  [{ txid, vout, value (sats), amount, blinding, spk, sign(tx, idx, prevouts) -> witness, witnessSizes, sequence? }]
  // outputs: [{ amount, blinding, script, keystream? }]; padded with zero-amount outputs to the wallet to 2, 4 or 8.
  // extraOutputs follow the payload outputs. satsUtxos are plain-sat coins that carry no note.
  function transfer({ asset, inputs, outputs, extraOutputs = [], satsUtxos, feeRate }) {
    if (!(asset instanceof Uint8Array) || asset.length !== 32) throw new Error('adaptor-btc-tx: asset must be 32 bytes');
    if (!inputs.length) throw new Error('adaptor-btc-tx: a transfer needs an input note');
    if (outputs.length < 1 || outputs.length > 8) throw new Error('adaptor-btc-tx: a transfer has 1 to 8 payload outputs');
    const inSum = inputs.reduce((s, i) => s + asBig(i.amount), 0n);
    const outSum = outputs.reduce((s, o) => s + asBig(o.amount), 0n);
    if (inSum !== outSum) throw new Error('adaptor-btc-tx: the outputs must hold exactly what the inputs hold');
    const m = outputs.length <= 2 ? 2 : outputs.length <= 4 ? 4 : 8;
    const anchor = anchorOf(inputs[0]);
    const outs = outputs.slice();
    for (let v = outs.length; v < m; v++) outs.push(selfOut(anchor, v, 0n));

    const { proof, commitments } = kit.rangeProve(outs.map((o) => asBig(o.amount)), outs.map((o) => o.blinding));
    const Cs = commitments.map(pointToBytes);
    const excess = modN(outs.reduce((s, o) => modN(s + o.blinding), 0n) - inputs.reduce((s, i) => modN(s + asBig(i.blinding)), 0n));
    if (excess === 0n) throw new Error('adaptor-btc-tx: the kernel excess is zero');
    const kernelSig = signSchnorr(kit.computeKernelMsg(asset, inputs.map((i) => ({ txid: i.txid, vout: i.vout })), Cs), bigintToBytes32(excess));
    const payload = kit.encodePayload({
      assetId: asset, kernelSig, rangeproof: proof,
      outputs: outs.map((o, i) => ({ commitment: Cs[i], encryptedAmount: o.keystream ? kit.encryptAmount(o.amount, o.keystream) : new Uint8Array(8) })),
    });
    const envelopeScript = prims.encodeEnvelopeScript(wallet.xonly(), payload);
    const { Q_xonly, parity } = prims.tweakedOutputKey(prims.TAP_NUMS, prims.tapLeafHash(envelopeScript));
    const commitSpk = prims.p2trScript(Q_xonly);
    const cb = prims.controlBlock(prims.TAP_NUMS, parity);

    const noteSats = inputs.reduce((s, i) => s + i.value, 0);
    const payloadOutputs = outs.map((o) => ({ value: DUST, script: o.script }));
    const extras = extraOutputs.map((o) => ({ value: o.value ?? 0, script: o.script }));
    const reveal = (commitTxid, satsChange) => ({
      version: 2, locktime: 0,
      inputs: [{ txid: commitTxid, vout: 0, sequence: SEQ, witness: [] },
        ...inputs.map((i) => ({ txid: i.txid, vout: i.vout, sequence: i.sequence ?? SEQ, witness: [] }))],
      outputs: [...payloadOutputs, ...extras, ...(satsChange >= DUST ? [{ value: satsChange, script: own }] : [])],
    });

    // The reveal's fee from its own size, with a sats-change output assumed and every signature at full length.
    const sized = reveal('00'.repeat(32), DUST);
    sized.inputs[0].witness = [new Uint8Array(64), envelopeScript, cb];
    inputs.forEach((i, k) => { sized.inputs[k + 1].witness = i.witnessSizes.map((n) => new Uint8Array(n)); });
    const revealFee = prims.feeFor(vsizeOf(sized), feeRate);

    const outTotal = payloadOutputs.length * DUST + extras.reduce((s, o) => s + o.value, 0);
    let commitValue = outTotal + revealFee - noteSats;
    let satsChange = 0;
    if (commitValue < DUST) { commitValue = DUST + revealFee; satsChange = commitValue + noteSats - outTotal - revealFee; }
    if (satsChange < DUST) satsChange = 0;

    // A coin of dust size may carry a note, and funding a commit from it would spend the note: only larger coins fund.
    const picked = [];
    let total = 0, commitFee = prims.feeFor(prims.estCommitVb(1), feeRate);
    for (const u of satsUtxos.filter((c) => c.value > DUST)) {
      picked.push(u); total += u.value;
      commitFee = prims.feeFor(prims.estCommitVb(picked.length), feeRate);
      if (total >= commitValue + commitFee + DUST) break;
    }
    if (total < commitValue + commitFee) throw new Error(`adaptor-btc-tx: not enough sats to fund the commit (need ${commitValue + commitFee}, have ${total})`);
    const commitChange = total - commitValue - commitFee;
    const commitTx = {
      version: 2, locktime: 0,
      inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: SEQ, witness: [] })),
      outputs: [{ value: commitValue, script: commitSpk }, ...(commitChange >= DUST ? [{ value: commitChange, script: own }] : [])],
    };
    prims.signCommitInputs(commitTx, picked, own);
    const commitTxid = prims.txid(commitTx);

    const revealTx = reveal(commitTxid, satsChange);
    const prevouts = [{ value: commitValue, script: commitSpk }, ...inputs.map((i) => ({ value: i.value, script: i.spk }))];
    revealTx.inputs[0].witness = prims.signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
    inputs.forEach((i, k) => { revealTx.inputs[k + 1].witness = i.sign(revealTx, k + 1, prevouts); });
    return {
      commitTx, revealTx, commitTxid, revealTxid: prims.txid(revealTx),
      commitHex: bytesToHex(prims.serializeTx(commitTx)), revealHex: bytesToHex(prims.serializeTx(revealTx)),
      commitFee, revealFee, kernelSig,
    };
  }

  const keyPathSigner = (sk, outputXonly) => (tx, idx, prevouts) => {
    const sh = prims.tapSighashKeyPath(tx, idx, prevouts, 0x00);
    const sig = signSchnorr(sh, priv32(sk));
    if (!verifySchnorr(sig, sh, outputXonly)) throw new Error('adaptor-btc-tx: the key-path signature does not verify under the lock output key');
    return [sig];
  };
  const refundSigner = (dLocker, lock) => (tx, idx, prevouts) => {
    const sh = prims.tapSighash(tx, idx, prevouts, lock.leafHash, 0x00);
    const sig = signSchnorr(sh, priv32(dLocker));
    const lockerXonly = lock.leaf.slice(lock.leaf.length - 33, lock.leaf.length - 1);
    if (!verifySchnorr(sig, sh, lockerXonly)) throw new Error('adaptor-btc-tx: this key is not the refund key of the lock');
    return [sig, lock.leaf, lock.controlBlock];
  };

  // LOCK: `lockAmount` of the wallet's notes (at its P2WPKH address) goes into the lock output; the rest returns to the
  // wallet. `hint` is the recovery OP_RETURN script (adaptor-xswap lockHintScript), placed after the payload outputs, and
  // `pay` ({ value, script }) a plain-sat output after it: the fee of the counterparty's take, paid to its address.
  function lockTransfer({ asset, notes, lock, lockAmount, rLock, hint = null, pay = null, satsUtxos, feeRate }) {
    const inputs = notes.map((n) => ({
      txid: n.txid, vout: n.vout, value: n.value, amount: n.amount, blinding: n.blinding, spk: own, witnessSizes: [72, 33],
      sign: (tx, idx, prevouts) => prims.signP2wpkhInput(tx, idx, prevouts[idx].value),
    }));
    const total = inputs.reduce((s, i) => s + asBig(i.amount), 0n);
    if (asBig(lockAmount) <= 0n || asBig(lockAmount) > total) throw new Error('adaptor-btc-tx: the lock amount must be positive and within the notes');
    const anchor = anchorOf(inputs[0]);
    const outputs = [
      { amount: asBig(lockAmount), blinding: asBig(rLock), script: lock.spk, keystream: kit.deriveAmountKeystreamSelf(wallet.priv, anchor, 0) },
      selfOut(anchor, 1, total - asBig(lockAmount)),
    ];
    if (pay && !(Number.isInteger(pay.value) && pay.value >= DUST)) throw new Error('adaptor-btc-tx: the take fee is below dust');
    const extraOutputs = [...(hint ? [{ value: 0, script: hint }] : []), ...(pay ? [{ value: pay.value, script: pay.script }] : [])];
    return transfer({ asset, inputs, outputs, extraOutputs, satsUtxos, feeRate });
  }

  // CLAIM: the whole lock output to the wallet, by key path with the secret `sk` that opens it (claimSecret).
  function claimTransfer({ asset, lockOut, lock, sk, amount, rLock, satsUtxos, feeRate }) {
    const input = { txid: lockOut.txid, vout: lockOut.vout, value: lockOut.value ?? DUST, amount, blinding: asBig(rLock), spk: lock.spk, witnessSizes: [64], sign: keyPathSigner(sk, lock.outputXonly) };
    return transfer({ asset, inputs: [input], outputs: [selfOut(anchorOf(input), 0, amount)], satsUtxos, feeRate });
  }

  // REFUND: the whole lock output back to the wallet, by the script path, once the output is `lock.csvBlocks` old.
  function refundTransfer({ asset, lockOut, lock, dLocker, amount, rLock, satsUtxos, feeRate }) {
    const input = {
      txid: lockOut.txid, vout: lockOut.vout, value: lockOut.value ?? DUST, amount, blinding: asBig(rLock), spk: lock.spk,
      sequence: lock.csvBlocks, witnessSizes: [64, lock.leaf.length, lock.controlBlock.length], sign: refundSigner(dLocker, lock),
    };
    return transfer({ asset, inputs: [input], outputs: [selfOut(anchorOf(input), 0, amount)], satsUtxos, feeRate });
  }

  // Commit first, then the reveal, which retries while the commit propagates. `onStage` hears 'commit' then 'reveal'.
  async function broadcastPair(pair, { onStage = null } = {}) {
    if (onStage) onStage('commit');
    await prims.broadcast(pair.commitHex);
    if (onStage) onStage('reveal');
    await prims.broadcastWithRetry(pair.revealHex);
    return { commitTxid: pair.commitTxid, revealTxid: pair.revealTxid };
  }

  return { transfer, lockTransfer, claimTransfer, refundTransfer, broadcastPair, vsizeOf };
}

