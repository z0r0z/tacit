// broadcastCbtcLockTx — the self-custody cBTC lock reveal builder (PLAN-cbtc-cusd-easy.md Part A, "the one
// genuinely new driver"). It is the tx-construction seam cbtc-lock.js injects: a Taproot commit→reveal that
// mirrors buildAndBroadcastBridgeDeposit (tacit.js ~11148), but the REVEAL emits a real self-custody lock
// OUTPUT (vBtc sats → lockSpk) at lockVout (=1, never 0 — the reflection fold skips a vout-0 lock), carrying
// the 197-byte 0x66 T_CBTC_LOCK envelope in its script-path witness.
//
// Two invariants that make the bearer note recoverable + the fold valid:
//   - commit vin[0] === fundingPrevout. cbtc-lock.js derives the note blinding from this exact prevout, and
//     scanCbtc re-derives it from the user's spends — get the ordering wrong and the BTC is stranded.
//   - the reveal's lockVout output value === vBtc, to lockSpk (the user's own self-custody script). Reflection
//     records {outpoint → vBtc, asset}; cBTC mints 1:1; redemption (0x67) later unlocks it.
//
// Dependency-injected on tacit.js's Bitcoin primitives (all module-level there) so it stays unit-testable and
// tacit.js keeps the wallet/broadcast specifics. Draft: prove on mainnet with a SMALL amount first
// (cbtc-lock.js's checklist) — this moves real BTC.
export function makeCbtcLockBroadcast(prims) {
  const {
    wallet,                       // { pub, xonly(), address() } — the module-level BTC wallet
    encodeEnvelopeScript, tapLeafHash, tweakedOutputKey, TAP_NUMS, p2trScript, controlBlock, p2wpkhScript,
    feeFor, getFeeRate, getUtxos, signCommitInputs, signTaprootScriptPathInput, serializeTx, txid,
    broadcast, broadcastWithRetry, estCommitVb, DUST, bytesToHex, hexToBytes,
  } = prims;
  const need = { encodeEnvelopeScript, tapLeafHash, tweakedOutputKey, p2trScript, controlBlock, p2wpkhScript, feeFor, getFeeRate, getUtxos, signCommitInputs, signTaprootScriptPathInput, serializeTx, txid, broadcast, broadcastWithRetry, estCommitVb };
  for (const [k, v] of Object.entries(need)) if (typeof v !== 'function') throw new Error(`cbtc-lock-broadcast: inject ${k}`);

  const asScript = (s) => (typeof s === 'string' ? hexToBytes(s) : s);

  // `feeRate` (sat/vB) is the caller's when it has sized the lock with one; `onSigned({ commitTxid, commitHex, revealHex, lockTxid, lockVout })`
  // is awaited once both transactions are signed and before either is sent, so a caller can keep them: a commit that is out without its
  // reveal holds the lock's sats until that exact reveal spends it.
  return async function broadcastCbtcLockTx({ fundingPrevout, vBtc, lockVout, lockSpk, envelopeHex, feeRate: givenRate = null, onSigned = null }) {
    const vSats = Number(vBtc);
    const lv = Number(lockVout);
    if (!Number.isInteger(lv) || lv < 1) throw new Error('cbtc-lock-broadcast: lockVout must be >= 1');
    if (!(vSats > 0)) throw new Error('cbtc-lock-broadcast: vBtc must be positive');

    const feeRate = givenRate > 0 ? givenRate : await getFeeRate('priority');
    const wpkhSpk = p2wpkhScript(wallet.pub);

    // Commit output = P2TR(NUMS, envelopeScript) so the reveal can script-path-spend it, revealing the 0x66.
    // buildCbtcLockEnvelope returns a 0x-prefixed hex string; this file's hexToBytes (vendor) expects bare hex.
    const envelopeScript = encodeEnvelopeScript(wallet.xonly(), hexToBytes(envelopeHex.replace(/^0x/, '')));
    const leaf = tapLeafHash(envelopeScript);
    const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, leaf);
    const p2trSpk = p2trScript(Q_xonly);
    const cb = controlBlock(TAP_NUMS, parity);

    // Reveal vB, as it serializes: one input, `lv` dust outputs to the wallet and the lock output, and a witness of the signature, the
    // envelope script and the control block. The commit P2TR must fund the lock sats + the dust outputs + the reveal fee.
    const spk = asScript(lockSpk), sl = envelopeScript.length;
    const revealVb = 51 + lv * 31 + 9 + spk.length + Math.ceil((102 + (sl < 253 ? 1 : 3) + sl) / 4);
    const revealFee = feeFor(revealVb, feeRate);
    const commitP2trValue = vSats + lv * DUST + revealFee;

    // Fund the commit — fundingPrevout FIRST (the blinding anchor), then add UTXOs for fees only if needed.
    const allUtxos = await getUtxos(wallet.address());
    const fundUtxo = allUtxos.find((u) => u.txid === fundingPrevout.txid && u.vout === fundingPrevout.vout);
    if (!fundUtxo) throw new Error('cbtc-lock-broadcast: funding prevout not found in wallet UTXOs');
    const picked = [fundUtxo]; let total = fundUtxo.value;
    let commitFee = feeFor(estCommitVb(1), feeRate);
    // Largest first, so the fewest inputs; a coin worth no more than its own input's fee is left where it is.
    const inputFee = Math.ceil((estCommitVb(2) - estCommitVb(1)) * feeRate);
    const rest = allUtxos.filter((u) => !(u.txid === fundingPrevout.txid && u.vout === fundingPrevout.vout) && u.value > inputFee).sort((a, b) => b.value - a.value);
    for (const u of rest) {
      if (total >= commitP2trValue + commitFee + DUST) break;
      picked.push(u); total += u.value; commitFee = feeFor(estCommitVb(picked.length), feeRate);
    }
    if (total < commitP2trValue + commitFee) {
      throw new Error(`cbtc-lock-broadcast: insufficient sats (need ~${commitP2trValue + commitFee}, have ${total})`);
    }
    const change = total - commitP2trValue - commitFee;
    const commitOutputs = [{ value: commitP2trValue, script: p2trSpk }];
    if (change >= DUST) commitOutputs.push({ value: change, script: wpkhSpk });
    const commitTx = { version: 2, locktime: 0,
      inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
      outputs: commitOutputs };
    signCommitInputs(commitTx, picked, wpkhSpk);
    const commitTxid = txid(commitTx);

    // Reveal: spend commit vout0 (script-path, 0x66 in the witness). Outputs: vout0..lockVout-1 are dust to the
    // wallet, lockVout carries vBtc to the self-custody lockSpk.
    const outputs = [];
    for (let i = 0; i <= lv; i++) outputs.push(i === lv ? { value: vSats, script: spk } : { value: DUST, script: wpkhSpk });
    const revealTx = { version: 2, locktime: 0,
      inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs };
    const prevouts = [{ value: commitP2trValue, script: p2trSpk }];
    revealTx.inputs[0].witness = signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
    const commitHex = bytesToHex(serializeTx(commitTx)), revealHex = bytesToHex(serializeTx(revealTx)), lockTxid = txid(revealTx);
    if (onSigned) await onSigned({ commitTxid, commitHex, revealHex, lockTxid, lockVout: lv });
    await broadcastWithRetry(commitHex);
    await broadcastWithRetry(revealHex);

    return { lockTxid, lockVout: lv, commitTxid };
  };
}
