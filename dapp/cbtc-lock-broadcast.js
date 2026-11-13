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

  // Commit output = P2TR(NUMS, envelopeScript) so the reveal can script-path-spend it, revealing the 0x66.
  // buildCbtcLockEnvelope returns a 0x-prefixed hex string; this file's hexToBytes (vendor) expects bare hex.
  function commitOf(envelopeHex) {
    const envelopeScript = encodeEnvelopeScript(wallet.xonly(), hexToBytes(envelopeHex.replace(/^0x/, '')));
    const { Q_xonly, parity } = tweakedOutputKey(TAP_NUMS, tapLeafHash(envelopeScript));
    return { envelopeScript, p2trSpk: p2trScript(Q_xonly), cb: controlBlock(TAP_NUMS, parity) };
  }
  // Reveal vB, as it serializes: one input, `lv` dust outputs to the wallet and the lock output, and a witness of the signature, the
  // envelope script and the control block.
  const revealVbOf = (lv, spk, sl) => 51 + lv * 31 + 9 + spk.length + Math.ceil((102 + (sl < 253 ? 1 : 3) + sl) / 4);
  // The reveal of a commit: it spends the commit's vout0 (script-path, 0x66 in the witness); vout0..lockVout-1 are dust to the
  // wallet, lockVout carries vBtc to the self-custody lockSpk. What is left of the commit's output is its fee.
  function revealOf({ commitTxid, commitValue, vSats, lv, spk, commit }) {
    const wpkhSpk = p2wpkhScript(wallet.pub), outputs = [];
    for (let i = 0; i <= lv; i++) outputs.push(i === lv ? { value: vSats, script: spk } : { value: DUST, script: wpkhSpk });
    const revealTx = { version: 2, locktime: 0, inputs: [{ txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] }], outputs };
    revealTx.inputs[0].witness = signTaprootScriptPathInput(revealTx, [{ value: commitValue, script: commit.p2trSpk }], commit.envelopeScript, commit.cb);
    return { revealHex: bytesToHex(serializeTx(revealTx)), lockTxid: txid(revealTx) };
  }

  // `feeRate` (sat/vB) is the caller's when it has sized the lock with one; `onSigned({ commitTxid, commitHex, revealHex, lockTxid, lockVout })`
  // is awaited once both transactions are signed and before either is sent, so a caller can keep them: a commit that is out without its
  // reveal holds the lock's sats until that exact reveal spends it.
  async function broadcastCbtcLockTx({ fundingPrevout, vBtc, lockVout, lockSpk, envelopeHex, feeRate: givenRate = null, onSigned = null }) {
    const vSats = Number(vBtc);
    const lv = Number(lockVout);
    if (!Number.isInteger(lv) || lv < 1) throw new Error('cbtc-lock-broadcast: lockVout must be >= 1');
    if (!(vSats > 0)) throw new Error('cbtc-lock-broadcast: vBtc must be positive');

    const feeRate = givenRate > 0 ? givenRate : await getFeeRate('priority');
    const wpkhSpk = p2wpkhScript(wallet.pub);
    const commit = commitOf(envelopeHex), { p2trSpk } = commit;

    // The commit P2TR must fund the lock sats + the dust outputs + the reveal fee.
    const spk = asScript(lockSpk);
    const revealFee = feeFor(revealVbOf(lv, spk, commit.envelopeScript.length), feeRate);
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

    const commitHex = bytesToHex(serializeTx(commitTx)), { revealHex, lockTxid } = revealOf({ commitTxid, commitValue: commitP2trValue, vSats, lv, spk, commit });
    if (onSigned) await onSigned({ commitTxid, commitHex, revealHex, lockTxid, lockVout: lv });
    await broadcastWithRetry(commitHex);
    await broadcastWithRetry(revealHex);

    return { lockTxid, lockVout: lv, commitTxid };
  }

  // A lock's commit, read back the other way: `amountOf(vSats)` gives the envelope a lock of that amount carries, and a commit already on
  // Bitcoin ({ txid, value, script } of its vout0) is this key's lock commit when one of the amounts its value allows reproduces its
  // script. The value is the amount, the dust outputs and the reveal's fee, at whatever whole rate the lock was sized with (`vbs`: the
  // reveal sizes it may have been sized by). → { vBtc, lockVout, revealHex, lockTxid }, or null when it is not a lock of this key.
  // Each amount tried is a commitment and a taproot tweak, so the page is given a turn every few dozen.
  broadcastCbtcLockTx.revealForCommit = async function ({ commit: c, lockVout, lockSpk, amountOf, maxRate = 600 }) {
    const lv = Number(lockVout), spk = asScript(lockSpk), want = String(c.script).replace(/^0x/, '').toLowerCase(), tried = new Set();
    const sl = commitOf(amountOf(1000)).envelopeScript.length, vbs = [revealVbOf(lv, spk, sl), Math.ceil((sl + 200) / 4) + 31 + 11 + 43];
    for (let rate = 1; rate <= maxRate; rate++) for (const vb of vbs) {
      const vSats = Number(c.value) - lv * DUST - feeFor(vb, rate);
      if (!(vSats > DUST) || tried.has(vSats)) continue;
      tried.add(vSats);
      if (tried.size % 40 === 0) await new Promise((turn) => setTimeout(turn, 0));
      const commit = commitOf(amountOf(vSats));
      if (bytesToHex(commit.p2trSpk) !== want) continue;
      return { vBtc: String(vSats), lockVout: lv, ...revealOf({ commitTxid: c.txid, commitValue: Number(c.value), vSats, lv, spk, commit }) };
    }
    return null;
  };
  return broadcastCbtcLockTx;
}
