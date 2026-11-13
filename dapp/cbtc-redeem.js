// Builds the T_CBTC_REDEEM (0x67) transactions that return a cBTC lock's bitcoin. One Bitcoin transaction spends the lock and burns
// exactly its value of cBTC notes held on Bitcoin (a CXFER burn with no outputs); the reflection then retires the lock before its
// rug scan, the pool sets cbtcLockRedeemed, and the bond comes back. cBTC reaches Bitcoin by a cross-out (crossout-ux.js), which
// leaves notes at P2TR(the key's x-only form) that crossout-notes.js finds again.
//
// commit  funding P2WPKH utxos → P2TR(NUMS, envelope leaf) [+ change]
// reveal  vin0 the commit output (the 109-byte envelope must be at vin[0].witness[1]), vin1 the lock, vin2.. the notes;
//         vout0 the unlocked BTC back to `to`
//
// A redeem the guest does not fold burns the notes and reads as a rug, because the vin scan nullifies spent notes and lock spends
// either way. So nothing is returned until the built reveal passes the guest's own fold over its serialized bytes (the mirror in
// confidential-pool.js) and every signature verifies. The envelope's lock_txid and the kernel's input txids are the txid bytes as
// they appear in the transaction, the reverse of the display txid.
//
// `prims` is makeBtcWallet(...).prims, `pool` makeConfidentialPool(...), `secp` and `sha256` the noble builds. `send` broadcasts
// through injected functions, commit first.

import { buildCbtcRedeemEnvelope } from './cbtc-envelope.js';
import { classifyConfidentialTx, extractInputs, extractTaprootEnvelope } from './burn-deposit-bitcoin.js';
import { verifySchnorr } from './bulletproofs.js';

// cxfer-core CBTC_ZK_ASSET_ID: the vin scan binds each spent note to its stored asset.
export const CBTC_ZK_ASSET_ID = '0x62a20d98fc1cd20289621d1315294cb8772f934d822e404b71e1f471cf0679c8';

const DUST = 546;
const P2WPKH_DUST = 294;
const MIN_RELAY_RATE = 1;
const MAX_NOTES = 24;
const DEFAULT_MAX_FEE_SATS = 100_000;     // guards against a mistyped fee rate
const KERNEL_DOMAIN = 'tacit-kernel-v1';

const stripHex = (h) => String(h ?? '').replace(/^0x/i, '');
const lc = (h) => stripHex(h).toLowerCase();
const isHex32 = (h) => /^[0-9a-f]{64}$/.test(lc(h));
const reverseHex = (h) => lc(h).match(/../g).reverse().join('');
const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
const u64le = (n) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(n), true); return b; };
const cat = (parts) => { const o = new Uint8Array(parts.reduce((s, p) => s + p.length, 0)); let i = 0; for (const p of parts) { o.set(p, i); i += p.length; } return o; };
const hexBytes = (h) => { const s = stripHex(h); if (s.length % 2) throw new Error('cbtc-redeem: odd-length hex'); const a = new Uint8Array(s.length / 2); for (let i = 0; i < a.length; i++) a[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16); return a; };
const bytesHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
const outpointId = (txid, vout) => `${lc(txid)}:${Number(vout)}`;

export function makeCbtcRedeem({ pool, secp, sha256, prims: defaultPrims = null, signSchnorr: defaultSign = null } = {}) {
  if (!pool || !secp || typeof sha256 !== 'function') throw new Error('cbtc-redeem: pool, secp and sha256 are required');
  const N = secp.CURVE.n;
  const mod = (x) => ((x % N) + N) % N;
  const b32 = (n) => hexBytes(mod(BigInt(n)).toString(16).padStart(64, '0'));
  const tagged = (tag, ...msgs) => { const t = sha256(new TextEncoder().encode(tag)); return sha256(cat([t, t, ...msgs])); };

  const NEED = ['wallet', 'encodeEnvelopeScript', 'tapLeafHash', 'tweakedOutputKey', 'TAP_NUMS', 'p2trScript', 'controlBlock', 'p2wpkhScript',
    'signP2wpkhInput', 'signTaprootKeypathInput', 'signTaprootScriptPathInput', 'tapSighash', 'tapSighashKeyPath', 'serializeTx', 'txid', 'bytesToHex', 'hexToBytes'];
  function primsOf(p) {
    const x = p || defaultPrims;
    if (!x) throw new Error('cbtc-redeem: pass prims (makeBtcWallet(...).prims)');
    for (const k of NEED) if (x[k] == null) throw new Error(`cbtc-redeem: prims.${k} missing`);
    return x;
  }

  // sha256("tacit-kernel-v1" ‖ asset ‖ n_in ‖ (txid_raw ‖ vout_LE)×n_in ‖ 0 ‖ burned_LE8), as cxfer_kernel_verify builds it with no
  // outputs. Inputs carry display txids and are reversed here.
  function kernelMsg({ inputs, burned }) {
    if (!inputs.length || inputs.length > 255) throw new Error('cbtc-redeem: the kernel takes 1..255 inputs');
    const parts = [new TextEncoder().encode(KERNEL_DOMAIN), hexBytes(CBTC_ZK_ASSET_ID), Uint8Array.of(inputs.length)];
    for (const i of inputs) parts.push(hexBytes(reverseHex(i.txid)), u32le(i.vout));
    parts.push(Uint8Array.of(0), u64le(burned));
    return sha256(cat(parts));
  }

  // BIP-341 key-path secret for a lock made by cbtc-lock-mint.js (no script tree).
  function tweakedSecret(priv32, P) {
    const d0 = BigInt('0x' + bytesHex(priv32));
    const pt = secp.ProjectivePoint.BASE.multiply(d0).toRawBytes(true);
    const d = pt[0] === 0x03 ? N - d0 : d0;
    const t = BigInt('0x' + bytesHex(tagged('TapTweak', pt.slice(1))));
    const sk = mod(d + t);
    const want = P.tweakedOutputKey(pt.slice(1), new Uint8Array(0)).Q_xonly;
    const got = secp.ProjectivePoint.BASE.multiply(sk).toRawBytes(true).slice(1);
    if (bytesHex(want) !== bytesHex(got)) throw new Error('cbtc-redeem: the tweaked lock key does not match the lock script');
    return b32(sk);
  }

  // How this key spends a prevout script; throws for a script it does not hold.
  function signerFor(spkHex, P) {
    const w = P.wallet, spk = lc(spkHex), xonly = w.xonly();
    if (spk === lc(bytesHex(P.p2wpkhScript(w.pub)))) {
      return { kind: 'p2wpkh', sign: (tx, i, prevouts) => P.signP2wpkhInput(tx, i, prevouts[i].value) };
    }
    if (spk === lc(bytesHex(P.p2trScript(P.tweakedOutputKey(xonly, new Uint8Array(0)).Q_xonly)))) {
      const sk = tweakedSecret(w.priv, P);
      return { kind: 'p2tr-tweaked', sign: (tx, i, prevouts) => P.signTaprootKeypathInput(tx, i, prevouts, sk), xonly: hexBytes(spk.slice(4)) };
    }
    if (spk === '5120' + bytesHex(xonly)) {
      return { kind: 'p2tr', sign: (tx, i, prevouts) => P.signTaprootKeypathInput(tx, i, prevouts, w.priv), xonly };
    }
    throw new Error('cbtc-redeem: that output is not held by this key');
  }

  const pointOf = (cx, cy) => secp.ProjectivePoint.fromAffine({ x: BigInt(cx), y: BigInt(cy) });
  const vsizeOf = (P, tx) => { const base = P.serializeTx(tx, false).length, total = P.serializeTx(tx, true).length; return Math.ceil((base * 3 + total) / 4); };

  function normLock(lock) {
    if (!lock || !isHex32(lock.txid)) throw new Error('cbtc-redeem: lock.txid must be the 32-byte display txid');
    const vout = Number(lock.vout);
    if (!Number.isInteger(vout) || vout < 1) throw new Error('cbtc-redeem: lock.vout must be at least 1 (the reflection skips a vout-0 lock)');
    const value = Number(lock.value);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error('cbtc-redeem: lock.value (the lock output\'s sats) is required');
    if (!/^[0-9a-f]+$/.test(lc(lock.spk || ''))) throw new Error('cbtc-redeem: lock.spk (the lock output\'s script, hex) is required');
    return { txid: lc(lock.txid), vout, value, spk: lc(lock.spk) };
  }
  function normNotes(notes, vBtc, xonlyHex) {
    if (!Array.isArray(notes) || !notes.length) throw new Error('cbtc-redeem: at least one cBTC note on Bitcoin is required');
    if (notes.length > MAX_NOTES) throw new Error(`cbtc-redeem: at most ${MAX_NOTES} notes in one redeem`);
    const seen = new Set();
    let sum = 0n;
    const out = notes.map((n, i) => {
      if (!isHex32(n.txid)) throw new Error(`cbtc-redeem: note ${i}: txid must be the 32-byte display txid`);
      const vout = Number(n.vout);
      if (!Number.isInteger(vout) || vout < 0) throw new Error(`cbtc-redeem: note ${i}: bad vout`);
      if (n.assetId != null && lc(n.assetId) !== lc(CBTC_ZK_ASSET_ID)) throw new Error(`cbtc-redeem: note ${i} is not cBTC`);
      const amount = BigInt(n.amount), blinding = mod(BigInt(n.blinding));
      if (amount <= 0n) throw new Error(`cbtc-redeem: note ${i}: amount must be positive`);
      const sats = Number(n.sats);
      if (!Number.isSafeInteger(sats) || sats < 1) throw new Error(`cbtc-redeem: note ${i}: sats (the output's BTC value) is required`);
      const id = outpointId(n.txid, vout);
      if (seen.has(id)) throw new Error(`cbtc-redeem: note ${i} is listed twice`);
      seen.add(id);
      const { cx, cy } = pool.commitXY(amount, blinding);
      if (n.cx != null && (BigInt(n.cx) !== BigInt(cx) || BigInt(n.cy) !== BigInt(cy))) throw new Error(`cbtc-redeem: note ${i}: the opening does not reproduce its commitment`);
      sum += amount;
      return { txid: lc(n.txid), vout, amount, blinding, sats, cx, cy, spk: '5120' + xonlyHex };
    });
    if (sum !== vBtc) throw new Error(`cbtc-redeem: the notes hold ${sum} but the lock is ${vBtc}; the burn must equal the lock exactly, so bridge exactly ${vBtc} (plus the relay's fee) to Bitcoin`);
    return out;
  }

  // Builds and checks both transactions; nothing is broadcast.
  //   lock { txid, vout, value, spk }; notes [{ txid, vout, sats, amount, blinding, cx?, cy?, assetId? }] at P2TR(the key's x-only);
  //   funding [{ txid, vout, value }] plain P2WPKH utxos for both fees; protectedOutpoints ['txid:vout'] other locks, never funding;
  //   to: script for the unlocked BTC (default the key's P2WPKH). Txids are display order.
  function buildRedeemTxs({ prims, lock: lockIn, notes: notesIn, funding, feeRate, to = null, expectedVBtc = null, protectedOutpoints = [], maxFeeSats = DEFAULT_MAX_FEE_SATS, signSchnorr = defaultSign } = {}) {
    const P = primsOf(prims);
    const sign = signSchnorr || P.signSchnorr;
    if (typeof sign !== 'function') throw new Error('cbtc-redeem: signSchnorr missing');
    const lock = normLock(lockIn);
    const vBtc = BigInt(lock.value);
    if (expectedVBtc != null && BigInt(expectedVBtc) !== vBtc) throw new Error(`cbtc-redeem: the pool records this lock at ${expectedVBtc} sats but its output holds ${vBtc}`);
    const xonlyHex = bytesHex(P.wallet.xonly());
    const notes = normNotes(notesIn, vBtc, xonlyHex);

    const rate = Number(feeRate);
    if (!Number.isFinite(rate) || rate < MIN_RELAY_RATE) throw new Error('cbtc-redeem: feeRate must be at least 1 sat/vB');
    const fee = (vb) => Math.ceil(vb * rate);

    // Spending the lock, a note or another lock as funding would forfeit a bond.
    const lockId = outpointId(lock.txid, lock.vout);
    const noteIds = new Set(notes.map((n) => outpointId(n.txid, n.vout)));
    const guard = new Set((protectedOutpoints || []).map((o) => (typeof o === 'string' ? lc(o) : outpointId(o.txid, o.vout))));
    const wpkhSpk = P.p2wpkhScript(P.wallet.pub);
    const wpkhHex = bytesHex(wpkhSpk);
    const pool0 = (funding || []).map((u) => {
      if (!isHex32(u.txid) || !Number.isInteger(Number(u.vout)) || !(Number(u.value) > 0)) throw new Error('cbtc-redeem: a funding utxo is malformed');
      if (u.scriptpubkey && lc(u.scriptpubkey) !== wpkhHex) throw new Error('cbtc-redeem: funding must be plain P2WPKH utxos of this key');
      const id = outpointId(u.txid, u.vout);
      if (id === lockId) throw new Error('cbtc-redeem: the lock itself was offered as funding; spending it outside the redeem would forfeit its bond');
      if (noteIds.has(id)) throw new Error('cbtc-redeem: a cBTC note was offered as funding');
      if (guard.has(id)) throw new Error('cbtc-redeem: a protected lock was offered as funding; spending it would forfeit its bond');
      return { txid: lc(u.txid), vout: Number(u.vout), value: Number(u.value) };
    }).sort((a, b) => b.value - a.value);
    if (!pool0.length) throw new Error('cbtc-redeem: no plain bitcoin to pay the fees; send a little to this key\'s address first');

    const lockSigner = signerFor(lock.spk, P);
    const noteSigner = signerFor('5120' + xonlyHex, P);
    const toSpk = to == null ? wpkhSpk : (typeof to === 'string' ? hexBytes(to) : to);

    // Kernel signature: the excess is the sum of the blindings, the key of Σ C_in − v·H.
    const kInputs = notes.map((n) => ({ txid: n.txid, vout: n.vout }));
    const kMsg = kernelMsg({ inputs: kInputs, burned: vBtc });
    const excess = mod(notes.reduce((s, n) => s + n.blinding, 0n));
    if (excess === 0n) throw new Error('cbtc-redeem: degenerate blinding sum');
    const kernelSig = sign(kMsg, b32(excess));
    const inPts = notes.map((n) => pointOf(n.cx, n.cy));
    const rawOuts = notes.map((n) => [reverseHex(n.txid), n.vout]);
    if (!pool.cxferKernelVerify({ asset: CBTC_ZK_ASSET_ID, inputOutpoints: rawOuts, inputPoints: inPts, outsCompressed: [], kernelSig: '0x' + bytesHex(kernelSig), burned: vBtc })) {
      throw new Error('cbtc-redeem: the burn kernel does not verify; the notes do not open to the amounts given');
    }

    const envelopeHex = buildCbtcRedeemEnvelope({ lockTxid: reverseHex(lock.txid), lockVout: lock.vout, vBtc, kernelSig: bytesHex(kernelSig) });
    const envelopeScript = P.encodeEnvelopeScript(P.wallet.xonly(), hexBytes(envelopeHex));
    const leaf = P.tapLeafHash(envelopeScript);
    const { Q_xonly, parity } = P.tweakedOutputKey(P.TAP_NUMS, leaf);
    const commitSpk = P.p2trScript(Q_xonly);
    const cb = P.controlBlock(P.TAP_NUMS, parity);

    const noteSatsTotal = notes.reduce((s, n) => s + n.sats, 0);

    // One build at the given fees; `probe` only measures size.
    function assemble(revealFee, commitFee, probe = false) {
      const commitValue = revealFee + DUST;
      const picked = []; let total = 0;
      for (const u of pool0) { picked.push(u); total += u.value; if (total >= commitValue + commitFee) break; }
      if (!probe && total < commitValue + commitFee) throw new Error(`cbtc-redeem: not enough plain bitcoin for the fees (need ~${commitValue + commitFee} sats, have ${total})`);
      const change = total - commitValue - commitFee;
      const commitOutputs = [{ value: commitValue, script: commitSpk }];
      if (change >= P2WPKH_DUST) commitOutputs.push({ value: change, script: wpkhSpk });
      const commitTx = { version: 2, locktime: 0, inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })), outputs: commitOutputs };
      picked.forEach((u, i) => { commitTx.inputs[i].witness = P.signP2wpkhInput(commitTx, i, u.value); });
      const commitTxid = P.txid(commitTx);

      const outValue = commitValue - revealFee + lock.value + noteSatsTotal;
      const revealTx = {
        version: 2, locktime: 0,
        inputs: [
          { txid: commitTxid, vout: 0, sequence: 0xfffffffd, witness: [] },
          { txid: lock.txid, vout: lock.vout, sequence: 0xfffffffd, witness: [] },
          ...notes.map((n) => ({ txid: n.txid, vout: n.vout, sequence: 0xfffffffd, witness: [] })),
        ],
        outputs: [{ value: outValue, script: toSpk }],
      };
      const prevouts = [
        { value: commitValue, script: commitSpk },
        { value: lock.value, script: hexBytes(lock.spk) },
        ...notes.map((n) => ({ value: n.sats, script: hexBytes(n.spk) })),
      ];
      revealTx.inputs[0].witness = P.signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
      revealTx.inputs[1].witness = lockSigner.sign(revealTx, 1, prevouts);
      for (let i = 0; i < notes.length; i++) revealTx.inputs[2 + i].witness = noteSigner.sign(revealTx, 2 + i, prevouts);
      return { commitTx, revealTx, prevouts, commitValue, outValue, picked, commitVb: vsizeOf(P, commitTx), revealVb: vsizeOf(P, revealTx), total };
    }

    const probe = assemble(fee(300), fee(170), true);
    let revealFee = fee(probe.revealVb + 2), commitFee = fee(probe.commitVb + 2), built = null;
    for (let i = 0; i < 6 && !built; i++) {
      const b = assemble(revealFee, commitFee);
      const needR = fee(b.revealVb), needC = fee(b.commitVb);
      if (revealFee >= needR && commitFee >= needC) built = b;
      else { revealFee = Math.max(revealFee, needR); commitFee = Math.max(commitFee, needC); }
    }
    if (!built) throw new Error('cbtc-redeem: could not settle the fees');
    if (revealFee + commitFee > maxFeeSats) throw new Error(`cbtc-redeem: the fees (${revealFee + commitFee} sats) are over the ${maxFeeSats} guard; check the fee rate`);

    const commitHex = P.bytesToHex(P.serializeTx(built.commitTx));
    const revealHex = P.bytesToHex(P.serializeTx(built.revealTx));

    // Checked on the serialized bytes, as the guest reads them.
    const verdict = checkRedeemReveal({
      prims: P, revealHex, lock, notes, prevouts: built.prevouts, envelopeScript, commitSpk, expectedFee: revealFee,
    });
    if (!verdict.ok) throw new Error(`cbtc-redeem: the built redeem failed its own check: ${verdict.problems.join('; ')}`);

    return {
      commitHex, commitTxid: P.txid(built.commitTx), revealHex, revealTxid: P.txid(built.revealTx),
      vBtc, feeRate: rate, commitFee, revealFee, commitVb: built.commitVb, revealVb: built.revealVb,
      outputSats: built.outValue, unlockedTo: bytesHex(toSpk), lockKind: lockSigner.kind, notes: notes.length,
      envelopeScriptHex: bytesHex(envelopeScript), commitValue: built.commitValue,
      consumes: [lockId, ...noteIds, ...built.picked.map((u) => outpointId(u.txid, u.vout))],
      checks: verdict.passed,
    };
  }

  // Runs the guest's fold over a built reveal and, given prevouts, envelopeScript and commitSpk, verifies its signatures.
  // Returns { ok, problems, passed }.
  function checkRedeemReveal({ prims = null, revealHex, lock: lockIn, notes, prevouts = null, envelopeScript = null, commitSpk = null, expectedFee = null } = {}) {
    const problems = [], passed = [];
    const need = (cond, ok, bad) => { if (cond) passed.push(ok); else problems.push(bad); return cond; };
    notes = notes.map((n) => (n.cx != null ? n : { ...n, ...pool.commitXY(BigInt(n.amount), mod(BigInt(n.blinding))) }));
    const lock = normLock(lockIn);
    const vBtc = BigInt(lock.value);
    const raw = stripHex(revealHex);

    const cls = classifyConfidentialTx(raw);
    if (!need(cls && cls.type === 'cbtc_redeem', 'the reveal classifies as a cBTC redeem', 'the reveal does not classify as a cBTC redeem (the envelope is not at vin[0].witness[1] or is malformed)')) return { ok: false, problems, passed };
    const env = extractTaprootEnvelope(raw);
    need(env && stripHex(env).length === 218, 'the envelope is the 109-byte redeem frame', 'the envelope is not 109 bytes');
    need(lc(cls.lockTxid) === reverseHex(lock.txid) && Number(cls.lockVout) === lock.vout, 'the envelope names the lock in raw txid order', 'the envelope does not name this lock (or names it in display txid order)');
    need(BigInt(cls.vBtc) === vBtc, 'the envelope burns exactly the lock\'s value', `the envelope burns ${cls.vBtc}, the lock holds ${vBtc}`);

    const vins = extractInputs(raw) || [];
    need(vins.length === 2 + notes.length, 'the reveal has the commit, the lock and the notes as inputs, nothing else', `the reveal has ${vins.length} inputs, expected ${2 + notes.length}`);
    const at = (i) => vins[i] && outpointId(reverseHex(vins[i].prevTxid), vins[i].prevVout);
    need(at(1) === outpointId(lock.txid, lock.vout), 'vin1 unlocks the lock', 'vin1 is not the lock');
    need(notes.every((n, i) => at(2 + i) === outpointId(n.txid, n.vout)), 'the note inputs follow in the kernel\'s order', 'the note inputs are not in the kernel\'s order');

    // The guest's fold over the real bytes.
    const st = pool.makeScanReflectionState();
    const G = secp.ProjectivePoint.BASE.toAffine();
    const rawLockTxid = '0x' + reverseHex(lock.txid);
    const tracked = st.foldCbtcLock({ asset: CBTC_ZK_ASSET_ID, cx: '0x' + G.x.toString(16).padStart(64, '0'), cy: '0x' + G.y.toString(16).padStart(64, '0'), vBtc: Number(vBtc), lockVout: lock.vout, lockTxid: rawLockTxid });
    need(tracked, 'a lock of this size can be tracked', 'the lock could not be tracked (zero value, or vout 0)');
    const noteRaw = new Map(notes.map((n) => [outpointId(reverseHex(n.txid), n.vout), n]));
    const spends = vins.filter((v) => noteRaw.has(outpointId(v.prevTxid, v.prevVout)));
    const retired = tracked && st.foldCbtcRedeem({
      lockTxid: cls.lockTxid, lockVout: cls.lockVout, vBtc: BigInt(cls.vBtc),
      txVins: vins.map((v) => ({ prevTxid: '0x' + stripHex(v.prevTxid), vout: v.prevVout })),
      inOutpoints: spends.map((v) => ['0x' + stripHex(v.prevTxid), v.prevVout]),
      inPoints: spends.map((v) => { const n = noteRaw.get(outpointId(v.prevTxid, v.prevVout)); return pointOf(n.cx, n.cy); }),
      kernelSig: cls.kernelSig,
    });
    need(retired != null && st.cbtcBackingSats() === 0n, 'the guest\'s fold retires the lock (never a rug) and the backing falls to zero', 'the guest\'s fold REJECTS this redeem: broadcasting it would burn the notes and read as a rug');

    if (prevouts && envelopeScript) {
      const P = primsOf(prims);
      const tx = parseTx(raw, P);
      const leaf = P.tapLeafHash(envelopeScript);
      need(verifySchnorr(tx.inputs[0].witness[0], P.tapSighash(tx, 0, prevouts, leaf, 0x00), P.wallet.xonly()), 'the commit input\'s signature verifies', 'the commit input\'s signature does not verify');
      const tweakedQ = P.p2trScript(P.tweakedOutputKey(P.TAP_NUMS, leaf).Q_xonly);
      need(commitSpk && bytesHex(tweakedQ) === bytesHex(commitSpk) && bytesHex(prevouts[0].script) === bytesHex(commitSpk), 'the commit output commits to this envelope', 'the commit output does not commit to this envelope');
      for (let i = 1; i < tx.inputs.length; i++) {
        const spk = bytesHex(prevouts[i].script);
        if (spk.startsWith('5120')) {
          need(verifySchnorr(tx.inputs[i].witness[0], P.tapSighashKeyPath(tx, i, prevouts, 0x00), hexBytes(spk.slice(4))), `vin${i}'s key-path signature verifies`, `vin${i}'s key-path signature does not verify`);
        } else {
          need(tx.inputs[i].witness.length === 2, `vin${i} carries a P2WPKH witness`, `vin${i} has no P2WPKH witness`);
        }
      }
      const inSum = prevouts.reduce((s, p) => s + p.value, 0), outSum = tx.outputs.reduce((s, o) => s + o.value, 0);
      need(inSum - outSum === expectedFee, 'the reveal pays the fee the commit funded', `the reveal pays ${inSum - outSum} sats, expected ${expectedFee}`);
      need(tx.outputs.length === 1 && tx.outputs[0].value >= DUST, 'the reveal has one output above dust', 'the reveal output is missing or dust');
    }
    return { ok: problems.length === 0, problems, passed };
  }

  // Reads a segwit reveal back into the tx object, for the signature checks.
  function parseTx(raw, P) {
    const b = hexBytes(raw); let p = 4;
    if (!(b[4] === 0 && b[5] === 1)) throw new Error('cbtc-redeem: expected a segwit transaction');
    p = 6;
    const vi = () => { const f = b[p++]; if (f < 0xfd) return f; if (f === 0xfd) { const v = b[p] | (b[p + 1] << 8); p += 2; return v; } const v = (b[p] | (b[p + 1] << 8) | (b[p + 2] << 16) | (b[p + 3] << 24)) >>> 0; p += 4; return v; };
    const nin = vi(); const inputs = [];
    for (let i = 0; i < nin; i++) {
      const txid = bytesHex(b.subarray(p, p + 32).slice().reverse()); p += 32;
      const vout = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0, true); p += 4;
      const sl = vi(); p += sl;
      const sequence = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0, true); p += 4;
      inputs.push({ txid, vout, sequence, witness: [] });
    }
    const nout = vi(); const outputs = [];
    for (let i = 0; i < nout; i++) { const value = Number(new DataView(b.buffer, b.byteOffset + p, 8).getBigUint64(0, true)); p += 8; const sl = vi(); outputs.push({ value, script: b.slice(p, p + sl) }); p += sl; }
    for (let i = 0; i < nin; i++) { const n = vi(); for (let j = 0; j < n; j++) { const l = vi(); inputs[i].witness.push(b.slice(p, p + l)); p += l; } }
    const locktime = new DataView(b.buffer, b.byteOffset + p, 4).getUint32(0, true);
    return { version: new DataView(b.buffer, b.byteOffset, 4).getUint32(0, true), locktime, inputs, outputs };
  }

  // Notes summing to exactly vBtc (the burn takes no change), fewest first, among those the reflection has credited and Bitcoin has
  // confirmed; null when none do.
  function pickNotes(notes, vBtc) {
    const want = BigInt(vBtc);
    const usable = (notes || []).filter((x) => x.amount != null && BigInt(x.amount) > 0n && x.credited === true && x.confirmed !== false && x.live !== false
      && (x.assetId == null || lc(x.assetId) === lc(CBTC_ZK_ASSET_ID)))
      .sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : BigInt(b.amount) < BigInt(a.amount) ? -1 : 0));
    const suffix = new Array(usable.length + 1).fill(0n);
    for (let i = usable.length - 1; i >= 0; i--) suffix[i] = suffix[i + 1] + BigInt(usable[i].amount);
    const go = (i, left, k, chosen) => {
      if (left === 0n) return k === 0 ? chosen : null;
      if (k === 0 || i >= usable.length || suffix[i] < left) return null;
      const a = BigInt(usable[i].amount);
      if (a <= left) { const r = go(i + 1, left - a, k - 1, [...chosen, usable[i]]); if (r) return r; }
      return go(i + 1, left, k, chosen);
    };
    for (let k = 1; k <= Math.min(MAX_NOTES, usable.length); k++) { const r = go(0, want, k, []); if (r) return r; }
    return null;
  }

  // Largest subset sum not above `limit`, capped so a long list stays cheap.
  function bestSubsetSum(amounts, limit) {
    let sums = new Set([0n]);
    for (const a of amounts) {
      if (a <= 0n || a > limit) continue;
      const next = new Set(sums);
      for (const s of sums) { if (s + a <= limit) next.add(s + a); if (next.size > 4096) break; }
      sums = next;
    }
    return sums.size ? [...sums].reduce((m, x) => (x > m ? x : m), 0n) : 0n;
  }

  // The next step to get a lock's bitcoin back, from facts already read:
  //   done / gone / unminted   the pool has it redeemed / it was spent without a redeem / no cBTC was minted on it
  //   ready      notes on Bitcoin sum to exactly the lock
  //   arriving   a bridge of cBTC to Bitcoin is under way
  //   bridge     bridge `bridge` (the shortfall plus the relay fee) from the private balance
  //   buy        the private balance is short by `lack`
  //   toobig     the bridge needed is over the cap
  function planRedeem({ lockState, notes = [], held = 0n, bridging = 0, fee = 0n, min = 0n, cap = null } = {}) {
    if (!lockState || BigInt(lockState.vBtc || 0) <= 0n) return { step: 'unknown' };
    const N = BigInt(lockState.vBtc);
    if (lockState.redeemed) return { step: 'done' };
    if (lockState.spent) return { step: 'gone' };
    if (lockState.minted === false) return { step: 'unminted' };
    const usable = notes.filter((x) => x.amount != null && x.credited === true && x.confirmed !== false && x.live !== false && (x.assetId == null || lc(x.assetId) === lc(CBTC_ZK_ASSET_ID)));
    const pick = pickNotes(usable, N);
    if (pick) return { step: 'ready', notes: pick, have: N };
    if (bridging > 0) return { step: 'arriving', have: bestSubsetSum(usable.map((x) => BigInt(x.amount)), N) };
    // A remainder under the bridge minimum cannot be bridged alone, so the whole lock is bridged again.
    const have = bestSubsetSum(usable.map((x) => BigInt(x.amount)), N);
    let short = N - have, bridge = short + BigInt(fee);
    if (have > 0n && bridge < BigInt(min)) { short = N; bridge = N + BigInt(fee); }
    if (cap != null && bridge > BigInt(cap)) return { step: 'toobig', short, bridge, have };
    if (BigInt(held) < bridge) return { step: 'buy', short, bridge, have, lack: bridge - BigInt(held) };
    return { step: 'bridge', short, bridge, have };
  }

  // Whether chain and pool allow the redeem now, from facts the caller has just read: the pool's record of the lock, which
  // inputs are still unspent, and the discovered notes. A lock never minted against is refused: burning cBTC to open it would
  // destroy value for nothing.
  function assessRedeem({ lock, lockState, unspent, notes = [], force = false } = {}) {
    const problems = [];
    const l = normLock(lock);
    if (!lockState || BigInt(lockState.vBtc || 0) <= 0n) problems.push('the pool has no record of this lock yet (its reflection proof may still be pending)');
    else {
      if (BigInt(lockState.vBtc) !== BigInt(l.value)) problems.push(`the pool records this lock at ${lockState.vBtc} sats but its output holds ${l.value}`);
      if (lockState.redeemed) problems.push('this lock is already redeemed');
      if (lockState.spent) problems.push('this lock was already spent on Bitcoin');
      if (lockState.minted === false && !force) problems.push('no cBTC was minted against this lock, so there is nothing to burn: spend it normally and take the bond back');
    }
    if (unspent && unspent.lock === false) problems.push('the lock output is already spent on Bitcoin');
    if (unspent && Array.isArray(unspent.notes) && unspent.notes.some((u) => u === false)) problems.push('a cBTC note is already spent on Bitcoin');
    notes.forEach((n, i) => {
      if (n.live === false) problems.push(`cBTC note ${i + 1} is not held by Bitcoin's proof on Ethereum, so spending it would burn nothing`);
      if (n.confirmed === false) problems.push(`cBTC note ${i + 1} has not confirmed on Bitcoin yet`);
      if (n.credited !== true) problems.push(`cBTC note ${i + 1} has not been credited by the reflection yet (spending it before then would burn it with no effect)`);
    });
    return { ok: problems.length === 0, problems };
  }

  // A lock nothing was minted on, taken back: one transaction that spends the lock's output to `to` (default the key's P2WPKH), its fee
  // out of the lock. Nothing is burned, so it is only for a lock with no cBTC and no bond on it (assessUnlock); with cBTC minted the same
  // spend reads as a rug. Nothing is broadcast.
  //   lock { txid, vout, value, spk } → { hex, txid, fee, outValue, vsize }
  function buildUnlockTx({ prims, lock: lockIn, feeRate, to = null, maxFeeSats = DEFAULT_MAX_FEE_SATS } = {}) {
    const P = primsOf(prims), lock = normLock(lockIn), signer = signerFor(lock.spk, P), rate = Number(feeRate);
    if (!(rate >= MIN_RELAY_RATE)) throw new Error('cbtc-redeem: feeRate must be at least 1 sat/vB');
    const toSpk = to ? (typeof to === 'string' ? hexBytes(to) : to) : P.p2wpkhScript(P.wallet.pub);
    const prevouts = [{ value: lock.value, script: hexBytes(lock.spk) }];
    const make = (value) => {
      const tx = { version: 2, locktime: 0, inputs: [{ txid: lock.txid, vout: lock.vout, sequence: 0xfffffffd, witness: [] }], outputs: [{ value, script: toSpk }] };
      tx.inputs[0].witness = signer.sign(tx, 0, prevouts);
      return tx;
    };
    const vsize = vsizeOf(P, make(lock.value)), fee = Math.ceil(vsize * rate), outValue = lock.value - fee;
    if (fee > maxFeeSats) throw new Error(`cbtc-redeem: a fee of ${fee} sats is over the ${maxFeeSats} this allows`);
    if (outValue < DUST) throw new Error('cbtc-redeem: the lock is too small to pay for its own spend');
    const tx = make(outValue);
    return { hex: bytesHex(P.serializeTx(tx, true)), txid: P.txid(tx), fee, outValue, vsize };
  }

  // Whether a lock can be taken back with a plain spend, from facts the caller has just read: no cBTC minted on it, no bond on it (a
  // lock is minted against only while its bond stands, so with none posted nothing can be minted while the spend confirms), and its
  // output still unspent. `minted` and `escrow` are null when they could not be read.
  function assessUnlock({ minted, escrow, lockState = null, spentBy = null } = {}) {
    const problems = [];
    if (minted == null) problems.push('whether cBTC was minted on this lock could not be read');
    else if (minted) problems.push('this lock has cBTC minted on it, so its BTC comes back by a redeem, not a plain spend');
    if (lockState && (lockState.spent || lockState.redeemed)) problems.push('this lock was already spent on Bitcoin');
    if (escrow == null) problems.push('the bond on this lock could not be read');
    else if (BigInt(escrow) > 0n) problems.push('a bond is still posted on this lock: take the bond back first');
    if (spentBy) problems.push('the lock output is already spent on Bitcoin');
    return { ok: problems.length === 0, problems };
  }

  // Commit first, then the reveal; both are already built and checked.
  async function send({ built, broadcast, broadcastWithRetry = null, isUnspent = null, onProgress = null } = {}) {
    if (!built || !built.commitHex || !built.revealHex) throw new Error('cbtc-redeem: nothing built to send');
    const say = (s) => { try { onProgress && onProgress(s); } catch {} };
    if (isUnspent) {
      // The inputs the reveal spends are checked once more before the commit goes out.
      for (const id of built.consumes) {
        const [txid, vout] = id.split(':');
        if (built.consumes.indexOf(id) >= 1 + built.notes) continue;
        if ((await isUnspent(txid, Number(vout))) === false) throw new Error(`cbtc-redeem: ${id} is already spent; nothing was broadcast`);
      }
    }
    const again = broadcastWithRetry || broadcast;           // "already known" counts as sent, so a repeat after a failed reveal is safe
    say('commit');
    await again(built.commitHex);
    say('reveal');
    await again(built.revealHex);
    say('done');
    return { commitTxid: built.commitTxid, revealTxid: built.revealTxid };
  }

  return { kernelMsg, signerFor: (spk, prims) => signerFor(spk, primsOf(prims)), buildRedeemTxs, checkRedeemReveal, assessRedeem, pickNotes, planRedeem, bestSubsetSum, send, buildUnlockTx, assessUnlock };
}
