// Constructs the two Bitcoin transactions a burn-deposit needs — the piece that, until now, only ever existed
// as ad hoc, hand-edited one-off scripts (one per real burn). See ops/DESIGN-burndep-live-tracer.md for the
// provenance/registration side this feeds into; this module only builds and signs transactions, it never
// submits or registers anything.
//
// Why two transactions, not one: reflect.rs defines the burned note as the burn tx's FIRST spent input, and
// reads the 161-byte 0x2B envelope from that SAME input's witness (extract_taproot_envelope) — so the envelope
// and the value can't be split across two inputs the way an ordinary bridge-burn splits them (see
// bridge-burn-broadcast.js). And the envelope can't be pre-committed into the note's own home script either,
// since it names fields (the destination leaf) that depend on choices made at burn time, not at note-creation
// time. The resolution both real burns and this module use:
//
//   1. MIGRATE — an ordinary confidential transfer (same shape as any other cxfer, just a different
//      destination) moves the source note's value into a fresh "burn-home" output: P2TR(NUMS, leaf(S)) where
//      S = OP_DROP <K1_xonly> OP_CHECKSIG. Because the internal key is NUMS (no known discrete log), this
//      output is script-path-only, and because S itself never references the envelope, S can be committed at
//      migration time even though the envelope it will eventually carry isn't chosen yet.
//   2. REVEAL — spends the burn-home output (input 0) plus a plain funding UTXO (input 1, fees only) via
//      script-path: witness = [sig, envelope-as-a-dummy-script-shaped-item, S, control-block]. S's OP_DROP
//      discards that dummy item before OP_CHECKSIG runs, so it never affects what Bitcoin's own consensus
//      validates — but the item is still real witness data, byte-for-byte where
//      dapp/burn-deposit-bitcoin.js's extractTaprootEnvelope (the same function reflect.rs mirrors) reads it
//      from. K1 (the burn-home's own spending key) is deterministic from the wallet key and the source note's
//      own outpoint, so nothing new needs backing up.
//
// The migrate step's own output then becomes one more hop in the note's provenance chain — the same chain
// worker/src/burndep-live-tracer.js already walks and dapp/burn-deposit-assembler.js already turns into a
// registration bundle. Nothing here changes either of those.
//
// Dependency-injected like bridge-burn-broadcast.js, with a wider `prims` surface since migration also builds
// an ordinary confidential transfer (bulletproofs+ range proof, kernel signature), not just a burn envelope:
// everything bridge-burn-broadcast.js needs (wallet, encodeEnvelopeScript, tapLeafHash, tweakedOutputKey,
// TAP_NUMS, p2trScript, controlBlock, p2wpkhScript, feeFor, getFeeRate, getUtxos, signP2wpkhInput,
// signTaprootScriptPathInput, serializeTx, txid, broadcast, broadcastWithRetry, estCommitVb, DUST, bytesToHex,
// hexToBytes, sha256) — all from ONE wallet-state source, e.g. makeBtcWallet(...).prims, since several of these
// implicitly read that source's own wallet.priv/.pub — plus encodeCXferBppPayload, computeKernelMsg,
// deriveChangeBlinding, deriveAmountKeystreamSelf, encryptAmount, signSchnorr and modN, which are pure/stateless
// and safe to source separately (e.g. from dapp/tacit.js directly). The burn-reveal's witness needs a 4th item
// spliced between the signature and the real script (the dummy envelope item) — built here by splicing into
// signTaprootScriptPathInput's normal 3-item return, not by asking for a lower-level variant.

import { extractInputs, classifyConfidentialTx } from './burn-deposit-bitcoin.js';
import { verifySchnorr } from './bulletproofs.js';
import { bppRangeProve, bigintToBytes32, pointToBytes, pedersenCommit } from './bulletproofs-plus.js';

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const DUST = 546;
const MIN_RELAY_RATE = 1;
// OP_DROP's dummy input when spending homeScriptS outside the burn-deposit reveal -- an empty push, the
// minimal valid witness item. homeScriptS = OP_DROP <K1> OP_CHECKSIG needs exactly one stack item ABOVE the
// signature for OP_DROP to remove before OP_CHECKSIG runs, regardless of whether anything meaningful rides in
// that slot -- Bitcoin's OP_DROP only cares that a stack item is there, never its content.
const EMPTY_ITEM = new Uint8Array(0);
const lc = (x) => String(x || '').toLowerCase();
const stripHex = (x) => String(x).replace(/^0x/, '');
const reverseHex = (h) => stripHex(h).match(/../g).reverse().join('');
const isZero = (x) => BigInt(x) === 0n;

export function makeBurnDepositReveal({ pool, secp, prims: defaultPrims = null } = {}) {
  if (!pool || !secp) throw new Error('burn-deposit-reveal: pool and secp are required');

  // wallet, and every function below that reads wallet.priv/.pub implicitly (signP2wpkhInput,
  // signTaprootScriptPathInput), must come from the SAME source (e.g. one makeBtcWallet(...) instance) — mixing
  // in a same-named function from elsewhere (dapp/tacit.js has its own, separately-stateful copies of these)
  // silently signs under the wrong wallet's key, since they don't share the mutable wallet object this module
  // relies on to sign the burn-home input under a swapped-in key. The MIGRATE_NEED extras are pure/stateless
  // (explicit key or data parameters, no implicit wallet dependency) and safe to source from anywhere.
  const BASE_NEED = ['wallet', 'encodeEnvelopeScript', 'tapLeafHash', 'tweakedOutputKey', 'TAP_NUMS', 'p2trScript', 'controlBlock',
    'p2wpkhScript', 'feeFor', 'getFeeRate', 'getUtxos', 'signP2wpkhInput', 'signTaprootScriptPathInput',
    'serializeTx', 'txid', 'broadcast', 'broadcastWithRetry', 'estCommitVb', 'DUST', 'bytesToHex', 'hexToBytes', 'sha256'];
  const MIGRATE_NEED = ['encodeCXferBppPayload', 'computeKernelMsg', 'deriveChangeBlinding', 'deriveAmountKeystreamSelf', 'encryptAmount', 'signSchnorr', 'modN'];
  // buildCancelTx alone needs tapSighash directly (not just BASE_NEED's signTaprootScriptPathInput, which
  // hardcodes vin index 0 -- see buildCancelTx's own header comment for why that matters here specifically).
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

  // Deterministic from the wallet key and the SOURCE note's own outpoint — recoverable from the wallet seed
  // alone, never a separately-backed-up secret. Mirrors the derivation every real burn-deposit has used.
  function deriveBurnHomeKey({ walletPriv, noteTxid, noteVout }, { sha256 }) {
    if (!(walletPriv instanceof Uint8Array) || walletPriv.length !== 32) throw new Error('burn-deposit-reveal: walletPriv must be Uint8Array(32)');
    const txidBytes = hexToBytesLocal(stripHex(noteTxid));
    if (txidBytes.length !== 32) throw new Error('burn-deposit-reveal: noteTxid must be 32 bytes');
    const seed = sha256(cat([new TextEncoder().encode('tacit-burnhome-v1'), walletPriv, txidBytes, Uint8Array.of(noteVout >>> 0)]));
    let d = BigInt('0x' + bytesToHexLocal(seed)) % secp.CURVE.n;
    if (d === 0n) throw new Error('burn-deposit-reveal: degenerate burn-home key — pick a different note outpoint');
    let pub = secp.getPublicKey(bigintToBytes32(d), true);
    if (pub[0] === 0x03) { d = secp.CURVE.n - d; pub = secp.getPublicKey(bigintToBytes32(d), true); }
    return { priv: bigintToBytes32(d), pub, xonly: pub.slice(1) };
  }
  const homeScriptS = (xonly) => new Uint8Array([0x75, 0x20, ...xonly, 0xac]); // OP_DROP PUSH32(xonly) OP_CHECKSIG

  // ---- Phase 1: migrate a source note's value to its burn-home ----
  //   note        : { assetId, amount (confidential value), blinding, txid, vout, sats (the UTXO's BTC value) }
  //                 — a P2WPKH-homed note only; a P2TR-homed source is not yet implemented (throws, not guessed).
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

  // Build and sign the migration's commit + reveal. Nothing broadcast. fundingUtxo funds the commit
  // (must be plain sats — never a Tacit note); reveal outputs = [burn-home (DUST), change back to the wallet].
  // sourcePriv unlocks the SOURCE NOTE's own input specifically, when it differs from walletPriv — a
  // stealth-received note sits at P2WPKH(commit), commit = walletPub + b·G, not at P2WPKH(walletPub), so
  // its spend key is tweaked_sk (see dapp/tacit.js's per-input signing-key pattern), not walletPriv itself.
  // Everything else — the funding UTXO, the envelope's own authority, the reveal's sats-change output —
  // stays on walletPriv regardless of sourcePriv, exactly like this codebase's other assetSigner-override
  // spends (dapp/tacit.js): only the one input being unlocked ever uses the alternate key.
  async function buildMigrationTxs({ prims, note, walletPriv, fundingUtxo, feeRate = null, sourcePriv = null } = {}) {
    const P = primsOf(prims, MIGRATE_NEED);
    const plan = planMigrationToBurnHome({ note, walletPriv, sha256: P.sha256 });
    const rate = Number(feeRate != null ? feeRate : await P.getFeeRate('priority'));
    if (!Number.isFinite(rate) || rate < MIN_RELAY_RATE) throw new Error(`burn-deposit-reveal: fee rate ${rate} sat/vB is below the minimum relay rate`);
    if (!fundingUtxo || !fundingUtxo.txid || fundingUtxo.value == null) throw new Error('burn-deposit-reveal: fundingUtxo { txid, vout, value } required');

    // notePriv/notePub equal walletPriv/walletPub whenever sourcePriv is omitted, so every branch below
    // that picks between "wallet" and "note" collapses to the same value — no separate no-sourcePriv path.
    const notePriv = sourcePriv || walletPriv;
    const notePub = secp.getPublicKey(notePriv, true);

    const savedPriv = P.wallet.priv, savedPub = P.wallet.pub;
    try {
      P.wallet.priv = walletPriv; P.wallet.pub = secp.getPublicKey(walletPriv, true);
      const wpkhSpk = P.p2wpkhScript(P.wallet.pub);
      const fundingXonly = P.wallet.pub.slice(1);
      const noteSpk = P.p2wpkhScript(notePub);

      // Crypto over the single burn-home output (full amount, no split) — mirrors an ordinary single-output
      // T_CXFER_BPP exactly (kernel excess = out blinding − in blinding, BP+ range proof over the new commitment).
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
        // Standard 3-item script-path witness (unlike the burn-reveal below, the migration's envelope IS the
        // real committed script here — nothing extra to insert). The envelope's own authority is fundingXonly
        // (== walletPriv's x-only key, set just above) regardless of sourcePriv, so input 0 always signs under
        // walletPriv; input 1 (the note itself) signs under whichever key actually unlocks noteSpk. sign*Input
        // reads P.wallet.priv/.pub live, so the two calls bracket their own key — same save/restore pattern
        // this function already uses around itself (savedPriv/savedPub below).
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

      // Read it back the way the guest reads it: a cxfer landing on the burn-home script, at the expected value.
      // commitHex/revealHex are bare hex (no 0x) — the native Bitcoin convention, ready to broadcast as is;
      // classifyConfidentialTx/extractInputs (from dapp/burn-deposit-bitcoin.js) expect 0x-prefixed input and
      // return 0x-prefixed fields, so every comparison below normalizes explicitly rather than assuming either
      // side's convention.
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

  // Rebuilds the exact object buildMigrationTxs returns under `.burnHome`, from the wallet key and the
  // SOURCE note's own outpoint alone (deriveBurnHomeKey/deriveChangeBlinding are both keyed by that outpoint,
  // never by the burn-home's own txid — see planMigrationToBurnHome) — so a caller who lost buildMigrationTxs's
  // return value (a reloaded page, a different device) can recover it from data the wallet seed already
  // implies, once the migration itself is confirmed on chain. `chainSpk` is the REAL on-chain scriptPubKey at
  // burnHomeTxid:0 (bytes or hex, fetched by the caller — this module makes no network calls of its own,
  // matching every other function here); the reconstruction is refused rather than returned unverified if it
  // doesn't match, since an unverified wrong key here would build a burn-reveal that can't spend the real
  // output. deriveChangeBlinding needs computeKernelMsg's own sibling from MIGRATE_NEED, so prims here is the
  // same wider surface buildMigrationTxs takes, not just BASE_NEED.
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

  // ---- Phase 2: the burn-deposit reveal itself ----
  //   burnHome : the object buildMigrationTxs returned under `.burnHome` (or reconstructed identically from a
  //              stored migration record) — { txid, vout, value(sats), amount, blinding, priv, xonly, scriptS,
  //              controlBlock, spk }.
  //   envelope : { assetId, nullifier, destLeaf, target } — the 4 fields the 161-byte 0x2B envelope carries
  //              (bytes [33..65] are reserved, always zero — parsed but never read by the guest).
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

  // Build and sign the burn-deposit reveal. Nothing broadcast. fundingUtxo pays the fee (must be plain sats).
  async function buildBurnDepositRevealTxs({ prims, burnHome, envelope, fundingUtxo, feeRate = null } = {}) {
    const P = primsOf(prims);
    const plan = planBurnDepositReveal({ burnHome, envelope });
    const rate = Number(feeRate != null ? feeRate : await P.getFeeRate('priority'));
    if (!Number.isFinite(rate) || rate < MIN_RELAY_RATE) throw new Error(`burn-deposit-reveal: fee rate ${rate} sat/vB is below the minimum relay rate`);
    if (!fundingUtxo || !fundingUtxo.txid || fundingUtxo.value == null) throw new Error('burn-deposit-reveal: fundingUtxo { txid, vout, value } required');

    const savedPriv = P.wallet.priv, savedPub = P.wallet.pub;
    try {
      // Funding signs under the caller's own current wallet key — untouched. Only the burn-home input signs
      // under K1, swapped in for that one call, mirroring how every real burn-deposit built it (the signer
      // helper always reads wallet.priv, so this is the only way to sign under a second key with it).
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
        // witness3 = [sig, scriptS, controlBlock] (index 0, default sighash) — the dummy envelope item is
        // spliced in between the signature and the real script; S's own OP_DROP discards it at execution time.
        burnTx.inputs[0].witness = [witness3[0], envelopeItem, witness3[1], witness3[2]];
        burnTx.inputs[1].witness = P.signP2wpkhInput(burnTx, 1, fundingUtxo.value);
        return vsizeOf(P, burnTx).vsize;
      }
      let vb = sign();
      let fee = P.feeFor(vb, rate);
      const change = plan.burnHome.value + fundingUtxo.value - DUST - fee;
      if (change < 0) throw new Error(`burn-deposit-reveal: insufficient funds (short by ${-change} sats)`);
      if (change >= DUST) {
        // The change output adds to the size, so the fee is worked out again on the transaction that carries it, and the
        // change is what is left after that fee (another pass covers a signature a byte longer).
        burnTx.outputs.push({ value: change, script: fundingWpkhSpk });
        for (let i = 0; i < 3; i++) {
          vb = sign(); fee = P.feeFor(vb, rate);
          const next = plan.burnHome.value + fundingUtxo.value - DUST - fee;
          if (next < DUST) { burnTx.outputs.pop(); vb = sign(); break; }
          if (burnTx.outputs[1].value === next) break;
          burnTx.outputs[1].value = next;
        }
        if (burnTx.outputs[1]) vb = sign();                          // signed over the value it carries
      }
      const revealStd = checkStandard(P, burnTx, prevouts, 'burn-deposit reveal');

      // Read it back exactly the way the guest reads it — classifyConfidentialTx already routes through
      // extractTaprootEnvelope + parseBurnEnvelope internally, so this alone confirms the envelope round-trips.
      const revealHex = P.bytesToHex(P.serializeTx(burnTx));
      const cls = classifyConfidentialTx('0x' + revealHex);
      if (!cls || cls.type !== 'burn') throw new Error('burn-deposit-reveal: built transaction does not classify as a burn-deposit');
      if (lc(cls.assetId) !== lc(envelope.assetId) || lc(cls.nullifier) !== lc(envelope.nullifier)
        || lc(cls.dest) !== lc(envelope.destLeaf) || lc(cls.target) !== lc(envelope.target)) {
        throw new Error('burn-deposit-reveal: envelope read back from the built transaction differs from the plan');
      }
      // reflect.rs defines the burned note as the tx's FIRST spent input — extractInputs reports it in the
      // same internal byte order Bitcoin's own wire format uses, so the burn-home's display-hex txid (from
      // P.txid) is reversed before comparing.
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

  // ---- Phase 3: cancel — reclaim a stuck burn-home by moving its value into an ORDINARY note, via an
  // ordinary cxfer. This is "un-migrate": the exact same T_CXFER_BPP shape buildMigrationTxs itself uses to
  // move a note's value INTO a burn-home, run once more to move it back OUT, to a plain P2WPKH note this
  // wallet already knows how to find and spend (the same "self" derivation buildMigrationTxs already uses for
  // its own sats change: deriveChangeBlinding/deriveAmountKeystreamSelf, anchored to the note being spent).
  //
  // An earlier version of this reclaim spent the burn-home with a bare signature, no envelope at all. That
  // was a real mistake, not a simplification: T_CXFER_BPP's own wire format has no asset_input_count field
  // (unlike T_AXFER, which needs one precisely because CXFER doesn't — see encodeAxferPayload's own comment)
  // — CXFER hard-assumes exactly one asset input, and it is ALWAYS the SEPARATE input at vin[1], never the
  // envelope-carrying input at vin[0]. A bare payment carries no envelope at all, so classifyConfidentialTx
  // (extractTaprootEnvelope → parseCxferEnvelopeFull) recognizes nothing, and the confidential value —
  // already unlinked from its original note by the migrate step — has nowhere left to land. Only the burn-
  // home's incidental ~546 sats of real Bitcoin value would come back; the confidential amount would not.
  //
  // The fix is this function: a REAL two-input cxfer, structured exactly like buildMigrationTxs's own reveal
  // —
  //   vin[0] = a FRESH envelope-commit output (built here, same commit+reveal shape as buildMigrationTxs's
  //            own vin[0]) — carries the real T_CXFER_BPP envelope, standard 3-item script-path witness.
  //   vin[1] = the burn-home itself, spent via its own K1/S/controlBlock. homeScriptS is OP_DROP <K1>
  //            OP_CHECKSIG, which needs a witness item ABOVE the signature for OP_DROP to discard before
  //            OP_CHECKSIG runs regardless of any envelope (proven in this module's own test file via a
  //            from-scratch Script-stack simulation) — but unlike the burn-deposit reveal, that dummy item
  //            carries no meaning here, since this transaction's real envelope already lives on vin[0].
  //   vout[0] = the reclaimed note: plain P2WPKH(walletPub), value DUST, with the ORIGINAL confidential
  //             amount now committed under a FRESH, self-derived blinding — an ordinary note this wallet's
  //             own scanHoldings will find the same way it finds any other.
  //
  //   burnHome : the object reconstructBurnHome returns — { txid, vout, value(sats), amount, blinding, priv,
  //              pub, xonly, scriptS, controlBlock, spk }.
  //   walletPriv/walletPub : the SAME wallet the burn-home's own K1 was derived from. Self-reclaim only (no
  //              destination parameter) — sending a stuck burn-home's value to someone else is a real, later
  //              extension, not a gap in this one.
  //   fundingUtxo : required, exactly like buildBurnDepositRevealTxs — the burn-home's own value is fixed at
  //              DUST (546 sats), below this module's own fee floor once any spend is built at all.
  async function buildCancelTx({ prims, burnHome, assetId, walletPriv, walletPub, fundingUtxo, feeRate = null } = {}) {
    const P = primsOf(prims, [...MIGRATE_NEED, ...CANCEL_NEED]);
    if (!burnHome || !burnHome.priv) throw new Error('burn-deposit-reveal: burnHome required (from reconstructBurnHome)');
    // reconstructBurnHome's own return carries no assetId (it never needed one) -- the caller already knows
    // which asset this bridge is for, so it is taken explicitly here rather than smuggled onto burnHome.
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

      // Anchor: the burn-home's OWN outpoint — the asset input being spent, exactly mirroring
      // buildMigrationTxs's own anchor (the SOURCE note's outpoint there; here, the burn-home fills that
      // role, since it is the note now being spent). "Self" derivation (not the ECDH one buildAndBroadcastCXfer
      // uses for a THIRD-PARTY recipient) since this always pays back into the SAME wallet.
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
        // vin[0]: standard 3-item script-path witness — the envelope IS the real committed script here.
        // signTaprootScriptPathInput is safe to use as-is for this one: every existing caller in this module
        // already puts its Taproot-script-path input at vin[0], which is the one index this helper supports.
        rt.inputs[0].witness = P.signTaprootScriptPathInput(rt, prevouts, envelopeScript, envCb);
        // vin[1]: the burn-home, under K1. CXFER's own convention pins the envelope to vin[0] and the asset
        // being spent to a SEPARATE input (see this function's own header comment) — meaning this input can
        // never be vin[0], yet signTaprootScriptPathInput hardcodes tapSighash(tx, 0, ...) internally (see
        // bitcoin-taproot-wallet.js's own source): every OTHER caller in this codebase happens to only ever
        // sign a Taproot-script-path spend at vin[0], so that hardcoding was invisible until now. Signing
        // here goes one level lower — tapLeafHash + tapSighash(tx, 1, ...) + signSchnorr directly, with the
        // burn-home's own key passed explicitly rather than swapped into P.wallet — to get a signature that
        // is actually valid for the input it will really occupy. This was the exact mistake an earlier
        // attempt at this function made (reusing the wrapper unmodified at a non-zero index); this version's
        // own test file independently re-derives and checks this sighash rather than trusting either.
        // homeScriptS's leading OP_DROP still needs a witness item above the signature regardless of any
        // envelope; the dummy carries no meaning here (this tx's real envelope is entirely on vin[0]), so it
        // is empty, not envelope-shaped, unlike the burn-deposit reveal's own dummy.
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

      // The self-check that would have caught the mistake this function's own header comment describes:
      // the built transaction must actually classify as a real T_CXFER_BPP cxfer carrying the right asset and
      // commitment — not merely a validly-signed Bitcoin spend. A bare payment fails this immediately
      // (classifyConfidentialTx returns null), which is exactly the failure mode being guarded against.
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

  return { deriveBurnHomeKey, planMigrationToBurnHome, buildMigrationTxs, reconstructBurnHome, planBurnDepositReveal, buildBurnDepositRevealTxs, buildCancelTx };
}

// ---- small local byte helpers (kept dependency-free rather than importing a whole wallet module for these) ----
function hexToBytesLocal(h) { const s = String(h).replace(/^0x/, ''); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; }
function bytesToHexLocal(b) { return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join(''); }
function reverseBytes(b) { return Uint8Array.from(b).reverse(); }
function le32(n) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; }
function cat(arr) { let n = 0; for (const x of arr) n += x.length; const o = new Uint8Array(n); let i = 0; for (const x of arr) { o.set(x, i); i += x.length; } return o; }
