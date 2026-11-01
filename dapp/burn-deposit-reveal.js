
import { extractInputs, classifyConfidentialTx } from './burn-deposit-bitcoin.js';
import { verifySchnorr } from './bulletproofs.js';
import { bppRangeProve, bigintToBytes32, pointToBytes, pedersenCommit } from './bulletproofs-plus.js';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const DUST = 546;
const MIN_RELAY_RATE = 1;
const EMPTY_ITEM = new Uint8Array(0);
const lc = (x) => String(x || '').toLowerCase();
const stripHex = (x) => String(x).replace(/^0x/, '');
const reverseHex = (h) => stripHex(h).match(/../g).reverse().join('');
const isZero = (x) => BigInt(x) === 0n;

export function makeBurnDepositReveal({ pool, secp, prims: defaultPrims = null } = {}) {
  if (!pool || !secp) throw new Error('burn-deposit-reveal: pool and secp are required');

  const BASE_NEED = ['wallet', 'encodeEnvelopeScript', 'tapLeafHash', 'tweakedOutputKey', 'TAP_NUMS', 'p2trScript', 'controlBlock',
    'p2wpkhScript', 'feeFor', 'getFeeRate', 'getUtxos', 'signP2wpkhInput', 'signTaprootScriptPathInput',
    'serializeTx', 'txid', 'broadcast', 'broadcastWithRetry', 'estCommitVb', 'DUST', 'bytesToHex', 'hexToBytes', 'sha256'];
  const MIGRATE_NEED = ['encodeCXferBppPayload', 'computeKernelMsg', 'deriveChangeBlinding', 'deriveAmountKeystreamSelf', 'encryptAmount', 'signSchnorr', 'modN'];
  const CANCEL_NEED = ['tapSighash'];
  function primsOf(p, extra = []) {
    const x = p || defaultPrims;
    if (!x) throw new Error('burn-deposit-reveal: pass prims (makeBtcWallet(...).prims, extended per this module\'s header comment)');
    for (const k of [...BASE_NEED, ...extra]) if (x[k] == null) throw new Error(`burn-deposit-reveal: prims.${k} missing`);
    return x;
  }

  const vsizeOf = (P, tx) => {
    const base = P.serializeTx(tx, false).length, total = P.serializeTx(tx, true).length;
    return { vsize: Math.ceil((base * 3 + total) / 4), weight: base * 3 + total };
  };
  function checkStandard(P, tx, prevouts, label) {
    const { vsize, weight } = vsizeOf(P, tx);
    if (weight > 400000) throw new Error(`burn-deposit-reveal: ${label} exceeds the standard weight`);
    if (tx.version !== 2) throw new Error(`burn-deposit-reveal: ${label} must be version 2`);
    for (const o of tx.outputs) if (o.value < DUST) throw new Error(`burn-deposit-reveal: ${label} has a dust output (${o.value} sats)`);
    const inSum = prevouts.reduce((s, p) => s + p.value, 0), outSum = tx.outputs.reduce((s, o) => s + o.value, 0);
    const fee = inSum - outSum;
    if (fee < vsize * MIN_RELAY_RATE) throw new Error(`burn-deposit-reveal: ${label} pays ${fee} sats for ${vsize} vB, under the minimum relay fee`);
    return { vsize, weight, fee };
  }

  function deriveBurnHomeKey({ walletPriv, noteTxid, noteVout }, { sha256 }) {
    if (!(walletPriv instanceof Uint8Array) || walletPriv.length !== 32) throw new Error('burn-deposit-reveal: walletPriv must be Uint8Array(32)');
    const txidBytes = hexToBytesLocal(stripHex(noteTxid));
    if (txidBytes.length !== 32) throw new Error('burn-deposit-reveal: noteTxid must be 32 bytes');
    const seed = sha256(cat([new TextEncoder().encode('tacit-burnhome-v1'), walletPriv, txidBytes, noteVout < 256 ? Uint8Array.of(noteVout >>> 0) : le32(noteVout)]));
    let d = BigInt('0x' + bytesToHexLocal(seed)) % secp.CURVE.n;
    if (d === 0n) throw new Error('burn-deposit-reveal: degenerate burn-home key — pick a different note outpoint');
    let pub = secp.getPublicKey(bigintToBytes32(d), true);
    if (pub[0] === 0x03) { d = secp.CURVE.n - d; pub = secp.getPublicKey(bigintToBytes32(d), true); }
    return { priv: bigintToBytes32(d), pub, xonly: pub.slice(1) };
  }
  const homeScriptS = (xonly) => new Uint8Array([0x75, 0x20, ...xonly, 0xac]);

  function planMigrationToBurnHome({ note, walletPriv, sha256 } = {}) {
    if (!note) throw new Error('burn-deposit-reveal: note required');
    if (!HEX32.test(String(note.assetId)) || isZero(note.assetId)) throw new Error('burn-deposit-reveal: note.assetId must be a 32-byte asset id');
    if (!/^[0-9a-fA-F]{64}$/.test(stripHex(note.txid || ''))) throw new Error('burn-deposit-reveal: note.txid must be the display txid');
    const vout = Number(note.vout);
    if (!Number.isInteger(vout) || vout < 0) throw new Error('burn-deposit-reveal: bad note.vout');
    const sats = Number(note.sats);
    if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error('burn-deposit-reveal: note.sats (the UTXO\'s BTC value) required');
    const amount = BigInt(note.amount), blinding = BigInt(note.blinding);
    if (amount <= 0n) throw new Error('burn-deposit-reveal: note.amount must be positive');
    const inC = pedersenCommit(amount, blinding);
    const K1 = deriveBurnHomeKey({ walletPriv, noteTxid: note.txid, noteVout: vout }, { sha256 });
    const S = homeScriptS(K1.xonly);
    return { note: { ...note, vout, sats, amount, blinding }, inC, K1, S, assetIdBytes: hexToBytesLocal(stripHex(note.assetId)) };
  }

  async function buildMigrationTxs({ prims, note, walletPriv, fundingUtxo, feeRate = null, sourcePriv = null } = {}) {
    const P = primsOf(prims, MIGRATE_NEED);
    const plan = planMigrationToBurnHome({ note, walletPriv, sha256: P.sha256 });
    const rate = Number(feeRate != null ? feeRate : await P.getFeeRate('priority'));
    if (!Number.isFinite(rate) || rate < MIN_RELAY_RATE) throw new Error(`burn-deposit-reveal: fee rate ${rate} sat/vB is below the minimum relay rate`);
    if (!fundingUtxo || !fundingUtxo.txid || fundingUtxo.value == null) throw new Error('burn-deposit-reveal: fundingUtxo { txid, vout, value } required');

    const notePriv = sourcePriv || walletPriv;
    const notePub = secp.getPublicKey(notePriv, true);

    const savedPriv = P.wallet.priv, savedPub = P.wallet.pub;
    try {
      P.wallet.priv = walletPriv; P.wallet.pub = secp.getPublicKey(walletPriv, true);
      const wpkhSpk = P.p2wpkhScript(P.wallet.pub);
      const fundingXonly = P.wallet.pub.slice(1);
      const noteSpk = P.p2wpkhScript(notePub);

      const anchor = cat([reverseBytes(hexToBytesLocal(stripHex(plan.note.txid))), le32(plan.note.vout)]);
      const outBlinding = P.deriveChangeBlinding(walletPriv, anchor, 0);
      const ks = P.deriveAmountKeystreamSelf(walletPriv, anchor, 0);
      const { proof: rangeProof, commitments } = bppRangeProve([plan.note.amount], [outBlinding]);
      const commitmentBytes = commitments.map((pt) => pointToBytes(pt));
      const excess = P.modN(outBlinding - plan.note.blinding);
      const kernelMsg = P.computeKernelMsg(plan.assetIdBytes, [{ txid: plan.note.txid, vout: plan.note.vout }], commitmentBytes);
      const kernelSig = P.signSchnorr(kernelMsg, bigintToBytes32(excess));
      {
        const check = plan.inC.add(commitments[0].negate());
        if (!verifySchnorr(kernelSig, kernelMsg, check.toRawBytes(true).slice(1))) throw new Error('burn-deposit-reveal: migration kernel signature does not verify locally — refusing');
      }
      const payload = P.encodeCXferBppPayload({
        assetId: plan.assetIdBytes, kernelSig,
        outputs: [{ commitment: commitmentBytes[0], encryptedAmount: P.encryptAmount(plan.note.amount, ks) }],
        rangeproof: rangeProof,
      });
      if (payload[0] !== 0x22) throw new Error('burn-deposit-reveal: migration payload must be T_CXFER_BPP (0x22)');

      const envelopeScript = P.encodeEnvelopeScript(fundingXonly, payload);
      const { Q_xonly: envQ, parity: envParity } = P.tweakedOutputKey(P.TAP_NUMS, P.tapLeafHash(envelopeScript));
      const commitSpk = P.p2trScript(envQ);
      const envCb = P.controlBlock(P.TAP_NUMS, envParity);
      const burnHomeSpk = P.p2trScript(P.tweakedOutputKey(P.TAP_NUMS, P.tapLeafHash(plan.S)).Q_xonly);

      function buildReveal(commitTxid, commitValue, changeValue) {
        const rt = {
          version: 2, locktime: 0,
          inputs: [
            { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
            { txid: stripHex(plan.note.txid), vout: plan.note.vout, sequence: 0xfffffffd, witness: [] },
          ],
          outputs: [{ value: DUST, script: burnHomeSpk }],
        };
        if (changeValue >= DUST) rt.outputs.push({ value: changeValue, script: wpkhSpk });
        const prevouts = [{ value: commitValue, script: commitSpk }, { value: plan.note.sats, script: noteSpk }];
        P.wallet.priv = walletPriv; P.wallet.pub = secp.getPublicKey(walletPriv, true);
        rt.inputs[0].witness = P.signTaprootScriptPathInput(rt, prevouts, envelopeScript, envCb);
        P.wallet.priv = notePriv; P.wallet.pub = notePub;
        rt.inputs[1].witness = P.signP2wpkhInput(rt, 1, plan.note.sats);
        P.wallet.priv = walletPriv; P.wallet.pub = secp.getPublicKey(walletPriv, true);
        return rt;
      }
      const revealVb = vsizeOf(P, buildReveal('00'.repeat(32), 4000, 3000)).vsize;
      const revealFee = P.feeFor(revealVb, rate);
      const commitVb = P.estCommitVb(1);
      const commitFee = P.feeFor(commitVb, rate);
      const commitValue = fundingUtxo.value - commitFee;
      const changeValue = commitValue + plan.note.sats - DUST - revealFee;
      if (commitValue < DUST) throw new Error(`burn-deposit-reveal: funding UTXO too small (need > ${DUST + commitFee}, have ${fundingUtxo.value})`);
      if (changeValue < 0) throw new Error(`burn-deposit-reveal: insufficient funds for migration (short by ${-changeValue} sats)`);

      const commitTx = {
        version: 2, locktime: 0,
        inputs: [{ txid: fundingUtxo.txid, vout: fundingUtxo.vout, sequence: 0xfffffffd, witness: [] }],
        outputs: [{ value: commitValue, script: commitSpk }],
      };
      commitTx.inputs[0].witness = P.signP2wpkhInput(commitTx, 0, fundingUtxo.value);
      const commitTxid = P.txid(commitTx);
      const commitPrevouts = [{ value: fundingUtxo.value, script: fundingUtxo.scriptpubkey ? P.hexToBytes(fundingUtxo.scriptpubkey) : wpkhSpk }];
      const commitStd = checkStandard(P, commitTx, commitPrevouts, 'migration commit');

      const revealTx = buildReveal(commitTxid, commitValue, changeValue);
      const revealPrevouts = [{ value: commitValue, script: commitSpk }, { value: plan.note.sats, script: noteSpk }];
      const revealStd = checkStandard(P, revealTx, revealPrevouts, 'migration reveal');

      const commitHex = P.bytesToHex(P.serializeTx(commitTx));
      const revealHex = P.bytesToHex(P.serializeTx(revealTx));
      const cls = classifyConfidentialTx('0x' + revealHex);
      if (!cls || cls.type !== 'cxfer' || cls.opcode !== 0x22) throw new Error('burn-deposit-reveal: migration reveal does not classify as a T_CXFER_BPP cxfer');
      if (lc(cls.assetId) !== lc(plan.note.assetId)) throw new Error('burn-deposit-reveal: migration reveal classifies under the wrong asset');
      const clsCommit = lc((cls.commitments && cls.commitments[0]) || '');
      if (clsCommit && clsCommit !== lc('0x' + P.bytesToHex(commitmentBytes[0]))) throw new Error('burn-deposit-reveal: migration reveal commitment does not match');
      if (revealTx.outputs[0].value !== DUST || P.bytesToHex(revealTx.outputs[0].script) !== P.bytesToHex(burnHomeSpk)) throw new Error('burn-deposit-reveal: migration reveal output 0 is not the burn-home');

      const { cx: burnHomeCx, cy: burnHomeCy } = pool.decompressCommitment('0x' + P.bytesToHex(commitmentBytes[0]));
      return {
        commitTx, revealTx, commitHex, revealHex, commitTxid, revealTxid: P.txid(revealTx),
        commitFee: commitStd.fee, revealFee: revealStd.fee, feeRate: rate,
        burnHome: {
          txid: P.txid(revealTx), vout: 0, value: DUST, sats: DUST,
          amount: plan.note.amount, blinding: outBlinding, cx: burnHomeCx, cy: burnHomeCy,
          priv: plan.K1.priv, pub: plan.K1.pub, xonly: plan.K1.xonly, scriptS: plan.S,
          controlBlock: P.controlBlock(P.TAP_NUMS, P.tweakedOutputKey(P.TAP_NUMS, P.tapLeafHash(plan.S)).parity),
          spk: burnHomeSpk,
        },
      };
    } finally {
      P.wallet.priv = savedPriv; P.wallet.pub = savedPub;
    }
  }

  // Whether `spk` (hex) is the burn-home this key moves the note at `source` to: how a move found on chain is matched before its
  // amount is known.
  function isBurnHomeOf({ prims, walletPriv, source, spk } = {}) {
    const P = primsOf(prims);
    const K1 = deriveBurnHomeKey({ walletPriv, noteTxid: source.txid, noteVout: Number(source.vout) }, { sha256: P.sha256 });
    const home = P.p2trScript(P.tweakedOutputKey(P.TAP_NUMS, P.tapLeafHash(homeScriptS(K1.xonly))).Q_xonly);
    return lc(P.bytesToHex(home).replace(/^0x/, '')) === lc(stripHex(spk));
  }

  function reconstructBurnHome({ prims, walletPriv, source, amount, burnHomeTxid, chainSpk } = {}) {
    const P = primsOf(prims, MIGRATE_NEED);
    if (!source || !/^[0-9a-fA-F]{64}$/.test(stripHex(source.txid || ''))) throw new Error('burn-deposit-reveal: source.txid (display hex) required');
    const srcVout = Number(source.vout);
    if (!Number.isInteger(srcVout) || srcVout < 0) throw new Error('burn-deposit-reveal: bad source.vout');
    if (!/^[0-9a-fA-F]{64}$/.test(stripHex(burnHomeTxid || ''))) throw new Error('burn-deposit-reveal: burnHomeTxid (display hex) required');
    const amountBig = BigInt(amount);
    if (amountBig <= 0n) throw new Error('burn-deposit-reveal: amount must be positive');
    if (chainSpk == null) throw new Error('burn-deposit-reveal: chainSpk (the real on-chain scriptPubKey at burnHomeTxid:0) required — reconstruction is refused unverified');

    const K1 = deriveBurnHomeKey({ walletPriv, noteTxid: source.txid, noteVout: srcVout }, { sha256: P.sha256 });
    const S = homeScriptS(K1.xonly);
    const anchor = cat([reverseBytes(hexToBytesLocal(stripHex(source.txid))), le32(srcVout)]);
    const blinding = P.deriveChangeBlinding(walletPriv, anchor, 0);
    const commitment = pedersenCommit(amountBig, blinding);
    const spk = P.p2trScript(P.tweakedOutputKey(P.TAP_NUMS, P.tapLeafHash(S)).Q_xonly);
    const controlBlock = P.controlBlock(P.TAP_NUMS, P.tweakedOutputKey(P.TAP_NUMS, P.tapLeafHash(S)).parity);

    const chainSpkHex = lc(typeof chainSpk === 'string' ? stripHex(chainSpk) : P.bytesToHex(chainSpk).replace(/^0x/, ''));
    if (lc(P.bytesToHex(spk).replace(/^0x/, '')) !== chainSpkHex) {
      throw new Error('burn-deposit-reveal: reconstructed burn-home script does not match the real on-chain output — wrong wallet key or source outpoint');
    }
    const { cx, cy } = pool.decompressCommitment('0x' + P.bytesToHex(pointToBytes(commitment)));
    return {
      txid: stripHex(burnHomeTxid), vout: 0, value: DUST, sats: DUST,
      amount: amountBig, blinding, cx, cy,
      priv: K1.priv, pub: K1.pub, xonly: K1.xonly, scriptS: S, controlBlock, spk,
    };
  }

  function planBurnDepositReveal({ burnHome, envelope } = {}) {
    if (!burnHome || !burnHome.priv) throw new Error('burn-deposit-reveal: burnHome required (from buildMigrationTxs)');
    for (const k of ['assetId', 'nullifier', 'destLeaf', 'target']) {
      if (!HEX32.test(String(envelope && envelope[k]))) throw new Error(`burn-deposit-reveal: envelope.${k} must be a 32-byte hex value`);
    }
    const bytes = new Uint8Array(161);
    bytes[0] = 0x2b;
    bytes.set(hexToBytesLocal(stripHex(envelope.assetId)), 1);
    bytes.set(hexToBytesLocal(stripHex(envelope.nullifier)), 65);
    bytes.set(hexToBytesLocal(stripHex(envelope.destLeaf)), 97);
    bytes.set(hexToBytesLocal(stripHex(envelope.target)), 129);
    return { burnHome, envelopeBytes: bytes };
  }

  async function buildBurnDepositRevealTxs({ prims, burnHome, envelope, fundingUtxo, feeRate = null } = {}) {
    const P = primsOf(prims);
    const plan = planBurnDepositReveal({ burnHome, envelope });
    const rate = Number(feeRate != null ? feeRate : await P.getFeeRate('priority'));
    if (!Number.isFinite(rate) || rate < MIN_RELAY_RATE) throw new Error(`burn-deposit-reveal: fee rate ${rate} sat/vB is below the minimum relay rate`);
    if (!fundingUtxo || !fundingUtxo.txid || fundingUtxo.value == null) throw new Error('burn-deposit-reveal: fundingUtxo { txid, vout, value } required');

    const savedPriv = P.wallet.priv, savedPub = P.wallet.pub;
    try {
      const fundingWpkhSpk = fundingUtxo.scriptpubkey ? P.hexToBytes(fundingUtxo.scriptpubkey) : P.p2wpkhScript(P.wallet.pub);
      const envelopeItem = P.encodeEnvelopeScript(plan.burnHome.xonly, plan.envelopeBytes);
      const burnTx = {
        version: 2, locktime: 0,
        inputs: [
          { txid: stripHex(plan.burnHome.txid), vout: plan.burnHome.vout, sequence: 0xfffffffd, witness: [] },
          { txid: fundingUtxo.txid, vout: fundingUtxo.vout, sequence: 0xfffffffd, witness: [] },
        ],
        outputs: [{ value: DUST, script: fundingWpkhSpk }],
      };
      const prevouts = [{ value: plan.burnHome.value, script: plan.burnHome.spk }, { value: fundingUtxo.value, script: fundingWpkhSpk }];
      function sign() {
        P.wallet.priv = plan.burnHome.priv; P.wallet.pub = plan.burnHome.pub || secp.getPublicKey(plan.burnHome.priv, true);
        let witness3;
        try { witness3 = P.signTaprootScriptPathInput(burnTx, prevouts, plan.burnHome.scriptS, plan.burnHome.controlBlock); }
        finally { P.wallet.priv = savedPriv; P.wallet.pub = savedPub; }
        burnTx.inputs[0].witness = [witness3[0], envelopeItem, witness3[1], witness3[2]];
        burnTx.inputs[1].witness = P.signP2wpkhInput(burnTx, 1, fundingUtxo.value);
        return vsizeOf(P, burnTx).vsize;
      }
      let vb = sign();
      let fee = P.feeFor(vb, rate);
      const change = plan.burnHome.value + fundingUtxo.value - DUST - fee;
      if (change < 0) throw new Error(`burn-deposit-reveal: insufficient funds (short by ${-change} sats)`);
      if (change >= DUST) {
        burnTx.outputs.push({ value: change, script: fundingWpkhSpk });
        for (let i = 0; i < 3; i++) {
          vb = sign(); fee = P.feeFor(vb, rate);
          const next = plan.burnHome.value + fundingUtxo.value - DUST - fee;
          if (next < DUST) { burnTx.outputs.pop(); vb = sign(); break; }
          if (burnTx.outputs[1].value === next) break;
          burnTx.outputs[1].value = next;
        }
        if (burnTx.outputs[1]) vb = sign();
      }
      const revealStd = checkStandard(P, burnTx, prevouts, 'burn-deposit reveal');

      const revealHex = P.bytesToHex(P.serializeTx(burnTx));
      const cls = classifyConfidentialTx('0x' + revealHex);
      if (!cls || cls.type !== 'burn') throw new Error('burn-deposit-reveal: built transaction does not classify as a burn-deposit');
      if (lc(cls.assetId) !== lc(envelope.assetId) || lc(cls.nullifier) !== lc(envelope.nullifier)
        || lc(cls.dest) !== lc(envelope.destLeaf) || lc(cls.target) !== lc(envelope.target)) {
        throw new Error('burn-deposit-reveal: envelope read back from the built transaction differs from the plan');
      }
      const ins = extractInputs('0x' + revealHex);
      const burnHomeTxidInternal = '0x' + reverseHex(stripHex(plan.burnHome.txid));
      if (!ins || ins.length < 1 || lc(ins[0].prevTxid) !== lc(burnHomeTxidInternal) || ins[0].prevVout !== plan.burnHome.vout) {
        throw new Error('burn-deposit-reveal: burn-home is not the first spent input');
      }

      return {
        burnTx, revealHex, revealTxid: P.txid(burnTx), fee: revealStd.fee, feeRate: rate, vsize: revealStd.vsize,
        envelope: { assetId: envelope.assetId, nullifier: envelope.nullifier, destLeaf: envelope.destLeaf, target: envelope.target },
        burnedNote: { txid: plan.burnHome.txid, vout: plan.burnHome.vout, amount: plan.burnHome.amount, blinding: plan.burnHome.blinding },
      };
    } finally {
      P.wallet.priv = savedPriv; P.wallet.pub = savedPub;
    }
  }

  async function buildCancelTx({ prims, burnHome, assetId, walletPriv, walletPub, fundingUtxo, feeRate = null } = {}) {
    const P = primsOf(prims, [...MIGRATE_NEED, ...CANCEL_NEED]);
    if (!burnHome || !burnHome.priv) throw new Error('burn-deposit-reveal: burnHome required (from reconstructBurnHome)');
    if (!HEX32.test(String(assetId)) || isZero(assetId)) throw new Error('burn-deposit-reveal: assetId must be a 32-byte asset id');
    if (!(walletPriv instanceof Uint8Array) || walletPriv.length !== 32) throw new Error('burn-deposit-reveal: walletPriv must be Uint8Array(32)');
    if (!fundingUtxo || !fundingUtxo.txid || fundingUtxo.value == null) {
      throw new Error('burn-deposit-reveal: fundingUtxo { txid, vout, value } required — the burn-home\'s own value (fixed at DUST) cannot pay its own fee');
    }
    const rate = Number(feeRate != null ? feeRate : await P.getFeeRate('priority'));
    if (!Number.isFinite(rate) || rate < MIN_RELAY_RATE) throw new Error(`burn-deposit-reveal: fee rate ${rate} sat/vB is below the minimum relay rate`);

    const savedPriv = P.wallet.priv, savedPub = P.wallet.pub;
    try {
      P.wallet.priv = walletPriv; P.wallet.pub = walletPub || secp.getPublicKey(walletPriv, true);
      const wpkhSpk = P.p2wpkhScript(P.wallet.pub);
      const fundingXonly = P.wallet.pub.slice(1);

      const anchor = cat([reverseBytes(hexToBytesLocal(stripHex(burnHome.txid))), le32(burnHome.vout)]);
      const outBlinding = P.deriveChangeBlinding(walletPriv, anchor, 0);
      const ks = P.deriveAmountKeystreamSelf(walletPriv, anchor, 0);
      const { proof: rangeProof, commitments } = bppRangeProve([burnHome.amount], [outBlinding]);
      const commitmentBytes = commitments.map((pt) => pointToBytes(pt));
      const excess = P.modN(outBlinding - burnHome.blinding);
      const assetIdBytes = hexToBytesLocal(stripHex(assetId));
      const kernelMsg = P.computeKernelMsg(assetIdBytes, [{ txid: burnHome.txid, vout: burnHome.vout }], commitmentBytes);
      const kernelSig = P.signSchnorr(kernelMsg, bigintToBytes32(excess));
      {
        const inC = pedersenCommit(burnHome.amount, burnHome.blinding);
        const check = inC.add(commitments[0].negate());
        if (!verifySchnorr(kernelSig, kernelMsg, check.toRawBytes(true).slice(1))) throw new Error('burn-deposit-reveal: cancel kernel signature does not verify locally — refusing');
      }
      const payload = P.encodeCXferBppPayload({
        assetId: assetIdBytes, kernelSig,
        outputs: [{ commitment: commitmentBytes[0], encryptedAmount: P.encryptAmount(burnHome.amount, ks) }],
        rangeproof: rangeProof,
      });
      if (payload[0] !== 0x22) throw new Error('burn-deposit-reveal: cancel payload must be T_CXFER_BPP (0x22)');

      const envelopeScript = P.encodeEnvelopeScript(fundingXonly, payload);
      const { Q_xonly: envQ, parity: envParity } = P.tweakedOutputKey(P.TAP_NUMS, P.tapLeafHash(envelopeScript));
      const commitSpk = P.p2trScript(envQ);
      const envCb = P.controlBlock(P.TAP_NUMS, envParity);

      function buildReveal(commitTxid, commitValue, changeValue) {
        const rt = {
          version: 2, locktime: 0,
          inputs: [
            { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
            { txid: stripHex(burnHome.txid), vout: burnHome.vout, sequence: 0xfffffffd, witness: [] },
          ],
          outputs: [{ value: DUST, script: wpkhSpk }],
        };
        if (changeValue >= DUST) rt.outputs.push({ value: changeValue, script: wpkhSpk });
        const prevouts = [{ value: commitValue, script: commitSpk }, { value: burnHome.value, script: burnHome.spk }];
        rt.inputs[0].witness = P.signTaprootScriptPathInput(rt, prevouts, envelopeScript, envCb);
        const leaf1 = P.tapLeafHash(burnHome.scriptS);
        const sh1 = P.tapSighash(rt, 1, prevouts, leaf1, 0x00);
        const sig1 = P.signSchnorr(sh1, burnHome.priv);
        rt.inputs[1].witness = [sig1, EMPTY_ITEM, burnHome.scriptS, burnHome.controlBlock];
        return rt;
      }
      const revealVb = vsizeOf(P, buildReveal('00'.repeat(32), 4000, 3000)).vsize;
      const revealFee = P.feeFor(revealVb, rate);
      const commitVb = P.estCommitVb(1);
      const commitFee = P.feeFor(commitVb, rate);
      const commitValue = fundingUtxo.value - commitFee;
      const changeValue = commitValue + burnHome.value - DUST - revealFee;
      if (commitValue < DUST) throw new Error(`burn-deposit-reveal: funding UTXO too small (need > ${DUST + commitFee}, have ${fundingUtxo.value})`);
      if (changeValue < 0) throw new Error(`burn-deposit-reveal: insufficient funds to cancel (short by ${-changeValue} sats)`);

      const commitTx = {
        version: 2, locktime: 0,
        inputs: [{ txid: fundingUtxo.txid, vout: fundingUtxo.vout, sequence: 0xfffffffd, witness: [] }],
        outputs: [{ value: commitValue, script: commitSpk }],
      };
      commitTx.inputs[0].witness = P.signP2wpkhInput(commitTx, 0, fundingUtxo.value);
      const commitTxid = P.txid(commitTx);
      const commitPrevouts = [{ value: fundingUtxo.value, script: fundingUtxo.scriptpubkey ? P.hexToBytes(fundingUtxo.scriptpubkey) : wpkhSpk }];
      const commitStd = checkStandard(P, commitTx, commitPrevouts, 'cancel commit');

      const revealTx = buildReveal(commitTxid, commitValue, changeValue);
      const revealPrevouts = [{ value: commitValue, script: commitSpk }, { value: burnHome.value, script: burnHome.spk }];
      const revealStd = checkStandard(P, revealTx, revealPrevouts, 'cancel reveal');

      const commitHex = P.bytesToHex(P.serializeTx(commitTx));
      const revealHex = P.bytesToHex(P.serializeTx(revealTx));

      const cls = classifyConfidentialTx('0x' + revealHex);
      if (!cls || cls.type !== 'cxfer' || cls.opcode !== 0x22) throw new Error('burn-deposit-reveal: cancel reveal does not classify as a T_CXFER_BPP cxfer');
      if (lc(cls.assetId) !== lc(assetId)) throw new Error('burn-deposit-reveal: cancel reveal classifies under the wrong asset');
      const clsCommit = lc((cls.commitments && cls.commitments[0]) || '');
      if (clsCommit && clsCommit !== lc('0x' + P.bytesToHex(commitmentBytes[0]))) throw new Error('burn-deposit-reveal: cancel reveal commitment does not match');
      if (revealTx.outputs[0].value !== DUST || P.bytesToHex(revealTx.outputs[0].script) !== P.bytesToHex(wpkhSpk)) throw new Error('burn-deposit-reveal: cancel reveal output 0 is not the reclaimed note');
      const ins = extractInputs('0x' + revealHex);
      const burnHomeTxidInternal = '0x' + reverseHex(stripHex(burnHome.txid));
      if (!ins || ins.length !== 2 || lc(ins[1].prevTxid) !== lc(burnHomeTxidInternal) || ins[1].prevVout !== burnHome.vout) {
        throw new Error('burn-deposit-reveal: self-check failed — the burn-home is not vin[1] of the built cancel');
      }

      return {
        commitTx, revealTx, commitHex, revealHex, commitTxid, revealTxid: P.txid(revealTx),
        commitFee: commitStd.fee, revealFee: revealStd.fee, feeRate: rate,
        note: { txid: P.txid(revealTx), vout: 0, sats: DUST, amount: burnHome.amount, blinding: outBlinding, assetId },
      };
    } finally {
      P.wallet.priv = savedPriv; P.wallet.pub = savedPub;
    }
  }

  return { deriveBurnHomeKey, planMigrationToBurnHome, buildMigrationTxs, isBurnHomeOf, reconstructBurnHome, planBurnDepositReveal, buildBurnDepositRevealTxs, buildCancelTx };
}

function hexToBytesLocal(h) { const s = String(h).replace(/^0x/, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; }
function bytesToHexLocal(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
function reverseBytes(b) { return Uint8Array.from(b).reverse(); }
function le32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function cat(arr) { let n = 0; for (const x of arr) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of arr) { o.set(x, i); i += x.length; } return o; }
