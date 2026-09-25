// One-transaction joins and exits for the Bitcoin-native shielded pool (DESIGN-btc-shielded-pool.md §9,
// "Buy and shield" and "Exit to sats").
//
// buyAndShield: one Tacit carrier whose vin[0] is a T_BTC_SHIELD envelope and vin[1] is a pre-authorized sale's
//   lot. The seller signed SIGHASH_SINGLE|ANYONECANPAY over its input and its payout, so the payout sits at
//   vout[1]. Shield inputs are vin[1..n_in], so n_in = 1 and the lot is the shield's only input. The BIP-143
//   preimage of a SINGLE|ANYONECANPAY signature commits to the input's own outpoint, value and nSequence and to
//   the output at the same index, not to the input index; vin[1]/vout[1] is the placement the sale's skeleton
//   names and the one the shield needs. The buyer's envelope output funds the price and the fee; vout[0]
//   returns the buyer's change.
//
// exitToSats: the user builds and proves a spend that exits `amount` to a maker's script and wants `sats` paid
//   to a fresh key of the user's; the maker builds the carrier from its own coins. The want is in the proved
//   body and checked at acceptance, so the maker cannot take the exit without paying it.
//
// Proofs come from a proof system (btc-pool-halo2-prover.js makeHalo2System), run on the user's device.
//
// Pure: no network. `tacit` is the dapp's transaction toolkit (tacit.js exports or makeBtcWallet prims) bound
// to the buyer's Bitcoin key; `pool` is makeBtcShieldedPool(...).

const U64_MAX = (1n << 64n) - 1n;
const SIGHASH_SINGLE_ACP = 0x83;
const SEQ = 0xfffffffd;

// resolveNote for buyAndShield from tacit.js exports: the outpoint must pass validateOutpoint (full ancestry),
// then its asset and commitment are read from the envelope that defines it.
export function makeNoteResolver({ validateOutpoint, txOutputEnvelope, getParentEnvelopeData, fetchTx }) {
  return async (txid, vout) => {
    if ((await validateOutpoint(txid, vout, new Map(), fetchTx)) !== true) return null;
    const tx = await fetchTx(txid);
    const env = tx ? txOutputEnvelope(tx) : null;
    const pd = env ? await getParentEnvelopeData(env, vout, txid) : null;
    return pd ? { assetIdHex: pd.assetIdHex, commitment: pd.commitment } : null;
  };
}

export function makeBtcPoolZap({ secp, sha256, keccak256 }) {
  const concat = (...a) => { const o = new Uint8Array(a.reduce((s, x) => s + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const bytesToHex = (b) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const hexToBytes = (h) => {
    const s = String(h).replace(/^0x/i, '');
    if (s.length % 2 || /[^0-9a-f]/i.test(s)) throw new Error('btc-pool-zap: bad hex');
    const o = new Uint8Array(s.length / 2);
    for (let i = 0; i < o.length; i++) o[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
    return o;
  };
  const toBytes = (v) => (v instanceof Uint8Array ? v : hexToBytes(v));
  const hx = (b) => '0x' + bytesToHex(b);
  const strip = (h) => String(h).replace(/^0x/i, '').toLowerCase();
  const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0, true); return b; };
  const u64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
  const varslice = (b) => concat(b.length < 0xfd ? Uint8Array.of(b.length) : Uint8Array.of(0xfd, b.length & 0xff, b.length >> 8), b);
  const hash256 = (b) => sha256(sha256(b));
  const checkU32 = (x, name) => { if (!Number.isInteger(x) || x < 0 || x >= 2 ** 32) throw new Error(`btc-pool-zap: ${name} must be an integer in [0, 2^32)`); return x; };
  const checkSats = (x, name) => {
    const v = typeof x === 'bigint' ? x : Number.isSafeInteger(x) ? BigInt(x) : null;
    if (v === null || v < 0n || v > U64_MAX) throw new Error(`btc-pool-zap: ${name} must be a u64 (bigint or safe integer)`);
    return v;
  };

  // Output scripts a relaying node accepts, with their dust floors (Bitcoin Core, 3 sat/vB dust relay fee).
  function dustFor(spk) {
    const s = toBytes(spk), n = s.length;
    if (n === 34 && s[0] === 0x51 && s[1] === 0x20) return 330;
    if (n === 22 && s[0] === 0x00 && s[1] === 0x14) return 294;
    if (n === 34 && s[0] === 0x00 && s[1] === 0x20) return 330;
    if (n === 25 && s[0] === 0x76 && s[1] === 0xa9 && s[2] === 0x14 && s[23] === 0x88 && s[24] === 0xac) return 546;
    if (n === 23 && s[0] === 0xa9 && s[1] === 0x14 && s[22] === 0x87) return 540;
    return null;
  }

  // DER → 64-byte r ‖ s, null when malformed.
  function derToCompact(der) {
    if (!(der instanceof Uint8Array) || der.length < 8 || der.length > 72 || der[0] !== 0x30 || der[1] !== der.length - 2 || der[2] !== 0x02) return null;
    const rl = der[3];
    if (rl < 1 || rl > 33 || 4 + rl >= der.length || der[4 + rl] !== 0x02) return null;
    const sl = der[5 + rl];
    if (sl < 1 || sl > 33 || 6 + rl + sl !== der.length) return null;
    let r = der.slice(4, 4 + rl), s = der.slice(6 + rl);
    if (r.length === 33) { if (r[0]) return null; r = r.slice(1); }
    if (s.length === 33) { if (s[0]) return null; s = s.slice(1); }
    const out = new Uint8Array(64);
    out.set(r, 32 - r.length); out.set(s, 64 - s.length);
    return out;
  }

  // BIP-143 sighash of a P2WPKH input signed SIGHASH_SINGLE|ANYONECANPAY: its outpoint, value and nSequence,
  // and the output at its own index. Version 2 and locktime 0, as the sale skeleton.
  function singleAcpSighash({ outpoint, value, pkh, payout, sequence = SEQ }) {
    const scriptCode = concat(Uint8Array.of(0x76, 0xa9, 0x14), toBytes(pkh), Uint8Array.of(0x88, 0xac));
    const zero = new Uint8Array(32);
    return hash256(concat(
      u32(2), zero, zero,
      toBytes(outpoint.txid).slice().reverse(), u32(outpoint.vout),
      varslice(scriptCode), u64(value), u32(sequence),
      hash256(concat(u64(payout.value), varslice(toBytes(payout.script)))),
      u32(0), u32(SIGHASH_SINGLE_ACP),
    ));
  }

  // A pre-authorized sale as the preauth worker serves it, checked field by field.
  function readSale(sale, nowSec) {
    if (!sale || typeof sale !== 'object') throw new Error('btc-pool-zap: sale required');
    const need = ['asset_outpoint', 'asset_opening', 'min_price_sats', 'seller_payout_script', 'seller_pubkey', 'seller_asset_spend_sig'];
    for (const k of need) if (sale[k] == null) throw new Error(`btc-pool-zap: sale has no ${k}`);
    const op = sale.asset_outpoint;
    if (!/^[0-9a-f]{64}$/i.test(String(op.txid))) throw new Error('btc-pool-zap: sale outpoint txid');
    checkU32(op.vout, 'sale outpoint vout');
    if (!Number.isSafeInteger(op.value) || op.value <= 0) throw new Error('btc-pool-zap: sale outpoint value');
    if (!Number.isSafeInteger(sale.min_price_sats) || sale.min_price_sats <= 0) throw new Error('btc-pool-zap: sale price');
    const payout = toBytes(sale.seller_payout_script);
    if (!(payout.length === 22 && payout[0] === 0x00 && payout[1] === 0x14) && !(payout.length === 34 && payout[0] === 0x51 && payout[1] === 0x20)) {
      throw new Error('btc-pool-zap: seller payout must be P2WPKH or P2TR');
    }
    const sellerPub = toBytes(sale.seller_pubkey);
    if (sellerPub.length !== 33) throw new Error('btc-pool-zap: seller_pubkey must be 33 bytes');
    const sig = toBytes(sale.seller_asset_spend_sig);
    if (sig[sig.length - 1] !== SIGHASH_SINGLE_ACP) throw new Error('btc-pool-zap: seller signature is not SIGHASH_SINGLE|ANYONECANPAY');
    if (sale.expiry != null && !(Number(sale.expiry) > nowSec)) throw new Error('btc-pool-zap: sale has expired');
    if (!/^\d+$/.test(String(sale.asset_opening.amount))) throw new Error('btc-pool-zap: sale amount must be a decimal integer');
    const amount = BigInt(String(sale.asset_opening.amount));
    if (amount > U64_MAX) throw new Error('btc-pool-zap: sale amount out of range');
    if (!/^[0-9a-f]{64}$/.test(strip(sale.asset_opening.blinding))) throw new Error('btc-pool-zap: sale blinding must be 32 bytes hex');
    const blinding = BigInt('0x' + strip(sale.asset_opening.blinding));
    return { outpoint: { txid: strip(op.txid), vout: op.vout }, lotValue: op.value, price: sale.min_price_sats, payout, sellerPub, sig, amount, blinding };
  }

  // ── buy and shield ──
  // tacit: { encodeEnvelopeScript, tapLeafHash, tweakedOutputKey, TAP_NUMS, p2trScript, controlBlock, p2wpkhScript,
  //          signP2wpkhInput(tx, idx, value), signTaprootScriptPathInput(tx, prevouts, script, cb), serializeTx,
  //          txid, DUST, feeFor(vb, rate), estCommitVb(n), wallet: { pub, xonly() },
  //          resolveNote(txid, vout) → { assetIdHex, commitment(33) } for a note the transparent validator accepts,
//          e.g. makeNoteResolver over tacit.js }
  // wallet: { utxos: [{ txid, vout, value }] of tacit.wallet's P2WPKH, feeRate (sat/vB) }
  // system: the proof system; onProgress(stage) reports 'loading' / 'proving'.
  // Returns the signed commit and carrier; the caller broadcasts commit then carrier.
  async function buyAndShield({ tacit, pool, sale, wallet, recipientAddress, system, onProgress, rPool, e, aux, nowSec = Math.floor(Date.now() / 1000) }) {
    const s = readSale(sale, nowSec);
    const assetHex = strip(sale.asset_id ?? '');
    const lot = await tacit.resolveNote(s.outpoint.txid, s.outpoint.vout);
    if (!lot) throw new Error('btc-pool-zap: the lot is not a valid Tacit note');
    if (assetHex && strip(lot.assetIdHex) !== assetHex) throw new Error('btc-pool-zap: the lot is another asset');
    const C = secp.ProjectivePoint.fromHex(bytesToHex(toBytes(lot.commitment))).toAffine();
    const Cx = hx(toBytes(C.x.toString(16).padStart(64, '0'))), Cy = hx(toBytes(C.y.toString(16).padStart(64, '0')));

    // The seller's signature must hold at vin[1] against vout[1] = its payout, before any sats move.
    const sellerPkh = tacit.p2wpkhScript(s.sellerPub).slice(2);
    const sighash = singleAcpSighash({ outpoint: s.outpoint, value: s.lotValue, pkh: sellerPkh, payout: { value: s.price, script: s.payout } });
    const compact = derToCompact(s.sig.slice(0, -1));
    if (!compact || !secp.verify(compact, sighash, s.sellerPub, { lowS: true })) throw new Error('btc-pool-zap: seller signature does not verify');

    if (!system) throw new Error('btc-pool-zap: a proof system is required');
    // buildShieldEnvelope checks the published opening against the on-chain commitment.
    const shield = pool.buildShieldEnvelope({
      asset: '0x' + strip(lot.assetIdHex),
      inputs: [{ txid: s.outpoint.txid, vout: s.outpoint.vout, value: s.amount, blinding: s.blinding, Cx, Cy }],
      recipientAddress, rPool, e, aux,
    });
    const { payload } = await pool.prove(shield, system, { onProgress });
    shield.payload = payload;
    shield.payloadHex = hx(payload);

    const script = tacit.encodeEnvelopeScript(tacit.wallet.xonly(), payload);
    const { Q_xonly, parity } = tacit.tweakedOutputKey(tacit.TAP_NUMS, tacit.tapLeafHash(script));
    const commitSpk = tacit.p2trScript(Q_xonly);
    const cb = tacit.controlBlock(tacit.TAP_NUMS, parity);
    const buyerSpk = tacit.p2wpkhScript(tacit.wallet.pub);
    const DUST = tacit.DUST;
    const rate = Number(wallet.feeRate);
    if (!(rate > 0)) throw new Error('btc-pool-zap: feeRate must be positive');

    // Carrier: vin[0] envelope (script path), vin[1] lot; vout[0] buyer change, vout[1] seller payout.
    const pushLen = script.length < 0xfd ? 1 : 3;
    const witness = 1 + 65 + pushLen + script.length + 1 + cb.length + 1 + 1 + 72 + 1 + 33;
    const base = 4 + 1 + 41 * 2 + 1 + (9 + buyerSpk.length) + (9 + s.payout.length) + 4;
    const revealFee = tacit.feeFor(Math.ceil((base * 4 + 2 + witness) / 4) + 2, rate);
    const commitValue = Math.max(DUST, s.price + revealFee + DUST - s.lotValue);
    const change0 = commitValue + s.lotValue - s.price - revealFee;

    const coins = [...(wallet.utxos || [])]
      .filter((u) => !(u.txid === s.outpoint.txid && u.vout === s.outpoint.vout))
      .sort((a, b) => b.value - a.value);
    const picked = []; let total = 0, commitFee = 0;
    for (const u of coins) {
      picked.push(u); total += u.value;
      commitFee = tacit.feeFor(tacit.estCommitVb(picked.length), rate);
      if (total >= commitValue + commitFee + DUST) break;
    }
    if (total < commitValue + commitFee) throw new Error(`btc-pool-zap: need ${commitValue + commitFee} sats, have ${total}`);
    const commitChange = total - commitValue - commitFee;
    const commitTx = {
      version: 2, locktime: 0,
      inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: SEQ, witness: [] })),
      outputs: [{ value: commitValue, script: commitSpk }, ...(commitChange >= DUST ? [{ value: commitChange, script: buyerSpk }] : [])],
    };
    picked.forEach((u, i) => { commitTx.inputs[i].witness = tacit.signP2wpkhInput(commitTx, i, u.value); });
    const commitTxid = tacit.txid(commitTx);

    const carrierTx = {
      version: 2, locktime: 0,
      inputs: [
        { txid: commitTxid, vout: 0, sequence: SEQ, witness: [] },
        { txid: s.outpoint.txid, vout: s.outpoint.vout, sequence: SEQ, witness: [s.sig, s.sellerPub] },
      ],
      outputs: [{ value: change0, script: buyerSpk }, { value: s.price, script: s.payout }],
    };
    const prevouts = [{ value: commitValue, script: commitSpk }, { value: s.lotValue, script: tacit.p2wpkhScript(s.sellerPub) }];
    carrierTx.inputs[0].witness = tacit.signTaprootScriptPathInput(carrierTx, prevouts, script, cb);
    return {
      commitTx, carrierTx, commitTxid, carrierTxid: tacit.txid(carrierTx),
      commitHex: bytesToHex(tacit.serializeTx(commitTx)), carrierHex: bytesToHex(tacit.serializeTx(carrierTx)),
      shield, note: shield.note, commitValue, commitFee, revealFee,
    };
  }

  // ── exit to sats ──
  function makerTerms(maker) {
    if (!maker || typeof maker !== 'object') throw new Error('btc-pool-zap: maker terms required');
    const spk = toBytes(maker.spk);
    if (dustFor(spk) == null) throw new Error('btc-pool-zap: maker script is not a standard output script');
    const wantVout = checkU32(maker.vout ?? 1, 'maker vout');
    const exitVout = checkU32(maker.exitVout ?? (wantVout === 0 ? 1 : 0), 'maker exitVout');
    if (exitVout === wantVout) throw new Error('btc-pool-zap: exit and want need distinct outputs');
    const sats = checkSats(maker.sats, 'maker sats');
    if (maker.bind != null && (typeof maker.bind !== 'object' || !/^(0x)?[0-9a-f]{64}$/i.test(String(maker.bind.txid)))) throw new Error('btc-pool-zap: maker bind must be { txid, vout }');
    const bind = maker.bind ? { txid: strip(maker.bind.txid), vout: checkU32(maker.bind.vout, 'maker bind vout') } : null;
    return { spk, wantVout, exitVout, sats, bind };
  }

  // Builds a spend exiting `amount` to the maker's script with a want of `maker.sats` to a fresh key of the
  // wallet (seed + counter, design §6). Change goes to the internal address; `pad` fills the pool outputs to 3
  // with zero-value internal notes. Prove `spend` with pool.prove; the maker needs `offer`: the payload, the
  // exit opening and the payout script. Inputs are chosen from `notes` by pool.selectInputs and carry the
  // paths served at the anchor.
  function exitToSats({ pool, wallet, notes, note, amount, maker, asset, hAnchor, tip, root, usedScripts, pad = true }) {
    const m = makerTerms(maker);
    const v = checkSats(amount, 'amount');
    if (!wallet || wallet.internalAddress == null) throw new Error('btc-pool-zap: wallet has no internal address');
    const candidates = notes ?? (note ? [note] : []);
    const assetHex = asset ?? candidates[0]?.asset;
    if (assetHex == null) throw new Error('btc-pool-zap: asset required');
    const { inputs, total } = pool.selectInputs(candidates, v, { asset: assetHex });
    const payout = pool.freshExitKey(wallet, usedScripts ?? wallet.usedScripts);
    if (m.sats < BigInt(dustFor(payout.scriptPubKey))) throw new Error('btc-pool-zap: sats below the payout script dust floor');
    const change = total - v;
    const self = { address: wallet.internalAddress, network: wallet.network };
    const outputs = change > 0n ? [{ ...self, value: change }] : [];
    if (pad) while (outputs.length < 3) outputs.push({ ...self, value: 0n });
    const spend = pool.buildSpendBody({
      asset: assetHex, hAnchor, tip, root, inputs, outputs, network: wallet.network, usedScripts: new Set(),
      exit: { exitVout: m.exitVout, scriptPubKey: hx(m.spk), value: v },
      bind: m.bind,
      want: { vout: m.wantVout, value: m.sats, scriptPubKey: payout.scriptPubKey },
    });
    const used = usedScripts ?? wallet.usedScripts;
    if (used instanceof Set) used.add(payout.destSpkHash);
    return {
      spend, payout,
      offer: {
        body: spend.bodyHex,
        exitOpening: { value: spend.exit.value, blinding: spend.exit.blinding },
        payoutScriptPubKey: payout.scriptPubKey,
      },
    };
  }

  const sameBind = (a, b) => (a == null && b == null) || (!!a && !!b && strip(a.txid) === strip(b.txid) && a.vout === b.vout);

  // Maker-side check of an exit-to-sats offer before building the carrier. `payload` is the full envelope
  // (body ‖ proof_len ‖ proof) or a bare body. Throws on any mismatch; returns the parsed spend and the output
  // plan. `verify({ proof, publics })` with `root` checks the exit boundary and the proof natively when given.
  async function validateExitToSats({ pool, payload, offer, maker, amount, asset, root, verify }) {
    const m = makerTerms(maker);
    const v = checkSats(amount, 'amount');
    let sp, full = true;
    try { sp = pool.parseSpend(payload, { full: true }); } catch { sp = pool.parseSpend(payload); full = false; }
    if (asset != null && strip(sp.asset) !== strip(asset)) throw new Error('btc-pool-zap: offer is for another asset');
    if (!sp.exit) throw new Error('btc-pool-zap: offer has no exit');
    if (sp.exit.exitVout !== m.exitVout) throw new Error('btc-pool-zap: exit is not at the agreed output');
    if (strip(sp.exit.destSpkHash) !== bytesToHex(sha256(m.spk))) throw new Error('btc-pool-zap: exit does not pay the maker script');
    const op = offer?.exitOpening;
    if (!op) throw new Error('btc-pool-zap: offer has no exit opening');
    if (checkSats(typeof op.value === 'string' ? BigInt(op.value) : op.value, 'exit value') !== v) throw new Error('btc-pool-zap: exit amount is not the agreed amount');
    const C = pool.commitXY(v, BigInt(op.blinding));
    if (strip(C.cx) !== strip(sp.exit.cx) || strip(C.cy) !== strip(sp.exit.cy)) throw new Error('btc-pool-zap: exit opening does not open the exit commitment');
    if (!sp.want) throw new Error('btc-pool-zap: offer has no want');
    if (sp.want.vout !== m.wantVout) throw new Error('btc-pool-zap: want is not at the agreed output');
    if (sp.want.value > m.sats) throw new Error('btc-pool-zap: want asks more than the agreed sats');
    const payoutSpk = toBytes(offer.payoutScriptPubKey ?? '');
    if (bytesToHex(sha256(payoutSpk)) !== strip(sp.want.spkHash)) throw new Error('btc-pool-zap: payout script does not match the want');
    const floor = dustFor(payoutSpk);
    if (floor == null) throw new Error('btc-pool-zap: payout script is not a standard output script');
    if (sp.want.value < BigInt(floor)) throw new Error('btc-pool-zap: want is below the payout script dust floor');
    if (!sameBind(sp.bind, m.bind)) throw new Error('btc-pool-zap: bind is not the maker outpoint');
    if (verify) {
      if (!full) throw new Error('btc-pool-zap: offer carries no proof');
      if (root == null) throw new Error('btc-pool-zap: root required to verify');
      let publics;
      try { ({ publics } = pool.payloadPublics(payload, { root })); } catch { throw new Error('btc-pool-zap: exit boundary does not verify'); }
      if ((await verify({ proof: toBytes(sp.proof), publics })) !== true) throw new Error('btc-pool-zap: proof does not verify');
    }
    return { spend: sp, exitVout: m.exitVout, wantVout: m.wantVout, wantValue: sp.want.value, payoutScriptPubKey: hx(payoutSpk) };
  }

  // Carrier outputs for a validated offer: the maker's exit output and the user's payout at their signed
  // indices; any lower index left free pays `filler` (the maker's change) `fillerValue` sats.
  function makerCarrierOutputs({ exitVout, wantVout, wantValue, payoutScriptPubKey, makerSpk, exitSats = null, filler = null, fillerValue = null }) {
    const n = Math.max(exitVout, wantVout) + 1;
    const exitScript = toBytes(makerSpk), fillScript = filler ? toBytes(filler) : exitScript;
    const out = [];
    for (let i = 0; i < n; i++) {
      if (i === exitVout) out.push({ value: exitSats ?? dustFor(exitScript), script: exitScript });
      else if (i === wantVout) out.push({ value: Number(wantValue), script: toBytes(payoutScriptPubKey) });
      else out.push({ value: fillerValue ?? dustFor(fillScript), script: fillScript });
    }
    return out;
  }

  return { buyAndShield, exitToSats, validateExitToSats, makerCarrierOutputs, singleAcpSighash, derToCompact, dustFor };
}
