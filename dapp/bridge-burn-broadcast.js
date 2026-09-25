// Bitcoin-side bridge burn for a REFLECTED note (source class 1 or 2): the commit/reveal pair that burns a note
// the reflection already holds, so the relayed OP_BRIDGE_MINT (confidential-bridge-mint.js) can mint it on
// Ethereum. Pays only BTC and relays through any standard node or explorer; the burn-deposit of a never-reflected
// note is a different transaction shape (burndep-broadcast.js).
//
// What the reflection guest requires of the reveal (contracts/sp1/confidential/src/reflect.rs, the burn fold):
//   - the 161-byte 0x2B envelope is read from vin[0]'s Taproot script-path witness [sig, script, control block]
//     (cxfer-core bitcoin::extract_taproot_envelope, parse_burn_envelope);
//   - the vin scan must find EXACTLY ONE live reflected note among the inputs, at any position, and its ν must
//     equal the envelope's ν; the envelope asset must equal that note's asset. Otherwise the note is still
//     nullified but no burn is recorded, so every one of these is checked here before anything is broadcast;
//   - ν and the burn id are over the note's leaf in its own domain: btc_note_leaf (class 1) or
//     btc_note_leaf_bound(.., chainBinding) (class 2), selected by the live-set bound tag;
//   - burnId = bridge_burn_id(REFLECTED, note txid, note vout, srcLeaf, envelope target), which is what the mint
//     looks up; the envelope's pool-root field is not read.
// Outputs are unconstrained. The reveal spends [commit:0 (envelope), note (key path)] and returns the note's
// sats and the commit value, net of the fee, to the wallet.
//
// Deps: { pool } — makeConfidentialPool(); { bridgeMint } — makeConfidentialBridgeMint() (the envelope builder);
// { prims } — makeBtcWallet(...).prims (signing, serialization, UTXOs, fee rate, standard broadcast), also
// accepted per call; { fetchImpl, relayBase } — for the reflected state, GET /reflection/dump.

import { secp } from './vendor/tacit-deps.min.js';
import { verifySchnorr } from './bulletproofs.js';
import { extractTaprootEnvelope, parseBurnEnvelope, extractInputs } from './burn-deposit-bitcoin.js';
import { isProtectedOutpoint } from './confidential-deployments.js';
import { destValueFor, txidInternal } from './confidential-bridge-mint.js';

const SOURCE_REFLECTED = 1, SOURCE_REFLECTED_BOUND = 2;
const BURN_SOURCE_REFLECTED = 1;
const U64_MAX = (1n << 64n) - 1n;
const ZERO32 = '0x' + '00'.repeat(32);
const MAX_SCRIPT_ELEMENT = 520;       // consensus push limit, tapscript included
const MAX_TAPSCRIPT_STACK_ITEM = 80;  // policy limit on the initial stack of a script-path spend
const MAX_STANDARD_WEIGHT = 400000;
const MIN_RELAY_RATE = 1;             // sat/vB

const HEX32 = /^0x[0-9a-fA-F]{64}$/;
const lc = (x) => String(x || '').toLowerCase();
const h32 = (x) => '0x' + String(x).replace(/^0x/, '').toLowerCase().padStart(64, '0');
const isZero = (x) => BigInt(x) === 0n;

export function makeBridgeBurnBroadcaster({ pool, bridgeMint, prims: defaultPrims = null, fetchImpl = null, relayBase = '' } = {}) {
  if (!pool || !bridgeMint) throw new Error('bridge-burn: pool and bridgeMint are required');

  const need = ['wallet', 'encodeEnvelopeScript', 'tapLeafHash', 'tweakedOutputKey', 'TAP_NUMS', 'p2trScript', 'controlBlock',
    'p2wpkhScript', 'feeFor', 'getFeeRate', 'getUtxos', 'signCommitInputs', 'signTaprootScriptPathInput',
    'signTaprootKeypathInput', 'tapSighash', 'tapSighashKeyPath', 'serializeTx', 'txid', 'broadcast', 'broadcastWithRetry',
    'estCommitVb', 'DUST', 'bytesToHex', 'hexToBytes'];
  function primsOf(p) {
    const x = p || defaultPrims;
    if (!x) throw new Error('bridge-burn: pass prims (makeBtcWallet(...).prims)');
    for (const k of need) if (x[k] == null) throw new Error(`bridge-burn: prims.${k} missing`);
    return x;
  }

  // The reflected state the burn is checked against: the relay's public export (the same record the mint reads).
  async function fetchBurnSnapshot({ network = 'mainnet' } = {}) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('bridge-burn: no fetch available');
    const root = String(relayBase || '').replace(/\/$/, '');
    const res = await f(`${root}/reflection/dump?network=${network === 'signet' ? 'signet' : 'mainnet'}`);
    if (!res.ok) throw new Error(`bridge-burn: reflection dump ${res.status}`);
    const j = await res.json();
    const s = j && j.snapshot;
    if (!s || !Array.isArray(s.noteLeaves) || !Array.isArray(s.liveTriples)) throw new Error('bridge-burn: reflection dump carries no note tree / live set');
    return { noteLeaves: s.noteLeaves, liveTriples: s.liveTriples, spentLinks: s.spentLinks || [], cbtcLockTriples: s.cbtcLockTriples || [], burnNodes: s.burnNodes || [], height: j.attestedHeight ?? s.height ?? null };
  }

  function indexSnapshot(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.noteLeaves) || !Array.isArray(snapshot.liveTriples)) {
      throw new Error('bridge-burn: snapshot { noteLeaves, liveTriples } required (fetchBurnSnapshot)');
    }
    const live = new Map();
    for (const [k, v, a, ak, b] of snapshot.liveTriples) live.set(h32(k), { commitment: h32(v), asset: h32(a), authKey: h32(ak || ZERO32), bound: b ? 1 : 0 });
    const locks = new Set((snapshot.cbtcLockTriples || []).map((t) => h32(t[0])));
    const spent = new Set((snapshot.spentLinks || []).map((l) => h32(Array.isArray(l) ? l[0] : l)));
    const leaves = new Set(snapshot.noteLeaves.map((l) => lc(l)));
    return { live, locks, spent, leaves };
  }

  const xonlyOf = (priv) => {
    if (!(priv instanceof Uint8Array) || priv.length !== 32) throw new Error('bridge-burn: notePriv must be Uint8Array(32)');
    return '0x' + Array.from(secp.getPublicKey(priv, true).slice(1), (b) => b.toString(16).padStart(2, '0')).join('');
  };

  // Everything the guest will check, resolved against the reflected state, before a transaction exists.
  //   note  { txid (display), vout, sats, asset, value, blinding, script? } — a wallet-held reflected note UTXO
  //   notePriv — the key of the note's P2TR output (its x-only key is the note's auth key, spent by key path)
  //   dest  { owner, blinding? , value? } — the Ethereum destination; value, if given, must be the burned value net of fee
  // Returns the envelope and every value the mint needs.
  function planBridgeBurn({ note, notePriv, chainBinding, dest, fee = 0n, sourceClass = null, deriveDestBlinding = null, snapshot, bitcoinPoolRoot = ZERO32 }) {
    if (!note) throw new Error('bridge-burn: note required');
    if (!HEX32.test(String(chainBinding)) || isZero(chainBinding)) throw new Error('bridge-burn: chainBinding (the target pool\'s CHAIN_BINDING) required');
    if (!HEX32.test(String(note.asset)) || isZero(note.asset)) throw new Error('bridge-burn: note.asset must be a 32-byte asset id');
    if (!/^[0-9a-fA-F]{64}$/.test(String(note.txid || '').replace(/^0x/, ''))) throw new Error('bridge-burn: note.txid must be the display txid');
    const vout = Number(note.vout);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('bridge-burn: bad note.vout');
    const sats = Number(note.sats);
    if (!Number.isSafeInteger(sats) || sats <= 0) throw new Error('bridge-burn: note.sats (the UTXO\'s BTC value) required');
    const value = BigInt(note.value), blinding = BigInt(note.blinding);
    if (value <= 0n || value > U64_MAX) throw new Error('bridge-burn: note value out of range');
    if (blinding <= 0n) throw new Error('bridge-burn: note blinding required');
    if (!dest || !HEX32.test(String(dest.owner)) || isZero(dest.owner)) throw new Error('bridge-burn: dest.owner must be a non-zero 32-byte Ethereum note owner');
    const f = BigInt(fee);
    const vDest = destValueFor({ burnValue: value, fee: f }); // refuses an off-ladder fee or one that eats the note
    if (dest.value != null && BigInt(dest.value) !== vDest) {
      throw new Error(`bridge-burn: dest.value ${dest.value} is not the burned value net of the fee (${vDest}); the mint proves v_burn == v_dest + fee`);
    }
    if (sourceClass != null && Number(sourceClass) !== SOURCE_REFLECTED && Number(sourceClass) !== SOURCE_REFLECTED_BOUND) {
      throw new Error('bridge-burn: this path burns reflected notes (class 1 or 2); a never-reflected note is a burn-deposit (burndep-broadcast.js)');
    }

    const owner = xonlyOf(notePriv);
    if (note.script != null) {
      const spk = lc(String(note.script).replace(/^0x/, ''));
      if (spk !== '5120' + owner.slice(2)) throw new Error('bridge-burn: note.script is not the P2TR output of notePriv (key-path spend with an untweaked key)');
    }

    const st = indexSnapshot(snapshot);
    const spentTxid = txidInternal(note.txid);
    const key = h32(pool.outpointKey(spentTxid, vout));
    const hit = st.live.get(key);
    if (!hit) throw new Error('bridge-burn: the note is not in the reflected live set (not reflected yet, already spent, or a different outpoint); wait for reflection to fold it');
    const { cx, cy } = pool.commitXY(value, blinding);
    if (hit.commitment !== h32(pool.commitmentHash(cx, cy))) throw new Error('bridge-burn: the note opening (value, blinding) does not match the reflected commitment');
    if (hit.asset !== h32(note.asset)) throw new Error('bridge-burn: note.asset differs from the reflected note\'s asset; the burn would nullify the note without recording a bridge-out');
    if (hit.authKey !== owner) throw new Error('bridge-burn: notePriv is not the reflected note\'s auth key');
    const cls = hit.bound === 1 ? SOURCE_REFLECTED_BOUND : SOURCE_REFLECTED;
    if (sourceClass != null && Number(sourceClass) !== cls) {
      throw new Error(`bridge-burn: the reflected note is class ${cls} (${cls === 2 ? 'bound' : 'unbound'}), not class ${sourceClass}; its ν would not match`);
    }

    const built = bridgeMint.buildBridgeBurnEnvelope({
      asset: h32(note.asset), bitcoinPoolRoot: h32(bitcoinPoolRoot), chainBinding: h32(chainBinding), sourceClass: cls,
      burned: { value, blinding, owner }, fee: f, dest: { owner: h32(dest.owner), blinding: dest.blinding }, deriveDestBlinding,
    });
    const srcLeaf = bridgeMint.sourceLeaf({ sourceClass: cls, asset: h32(note.asset), cx, cy, owner, chainBinding: h32(chainBinding) });
    if (!st.leaves.has(lc(srcLeaf))) {
      throw new Error(cls === SOURCE_REFLECTED_BOUND
        ? 'bridge-burn: the bound note\'s leaf is not in the reflected note tree under this chainBinding; burn it toward the deployment it is bound to'
        : 'bridge-burn: the note\'s leaf is not in the reflected note tree');
    }
    if (st.spent.has(h32(built.nullifier))) throw new Error('bridge-burn: the note\'s nullifier is already in the reflected spent set');
    const envBytes = String(built.envelope).replace(/^0x/, '');
    if (envBytes.length !== 322 || !envBytes.startsWith('2b')) throw new Error('bridge-burn: envelope is not the 161-byte 0x2B burn');
    const burnId = pool.bridgeBurnId(BURN_SOURCE_REFLECTED, spentTxid, vout, srcLeaf, h32(chainBinding));

    return {
      envelope: built.envelope, nullifier: built.nullifier, destLeaf: built.destLeaf, fee: f, sourceClass: cls, burnId, srcLeaf,
      spentTxid, spentVout: vout, noteKey: key, owner, sats, asset: h32(note.asset), chainBinding: h32(chainBinding),
      burned: { value, blinding, owner },
      dest: { value: built.dest.value, blinding: built.dest.blinding, owner: h32(dest.owner), cx: built.dest.cx, cy: built.dest.cy },
      liveIndex: st,
    };
  }

  const vsizeOf = (P, tx) => {
    const base = P.serializeTx(tx, false).length, total = P.serializeTx(tx, true).length;
    return { vsize: Math.ceil((base * 3 + total) / 4), weight: base * 3 + total };
  };

  // Tapscript policy for the envelope leaf: every push within the element limit, and only the signature on the
  // initial stack (the script and control block are exempt from the 80-byte item limit).
  function checkEnvelopeScript(script) {
    if (script.length < 36 || script[0] !== 0x20 || script[33] !== 0xac || script[34] !== 0x00 || script[35] !== 0x63) throw new Error('bridge-burn: envelope script is not PUSH32 key OP_CHECKSIG OP_FALSE OP_IF');
    let p = 36;
    while (p < script.length && script[p] !== 0x68) {
      const op = script[p++]; let n;
      if (op >= 1 && op <= 75) n = op;
      else if (op === 0x4c) n = script[p++];
      else if (op === 0x4d) { n = script[p] | (script[p + 1] << 8); p += 2; } else throw new Error(`bridge-burn: unexpected opcode 0x${op.toString(16)} in the envelope`);
      if (n > MAX_SCRIPT_ELEMENT) throw new Error('bridge-burn: envelope push exceeds 520 bytes');
      p += n;
    }
    if (p !== script.length - 1) throw new Error('bridge-burn: envelope script does not end at OP_ENDIF');
  }

  function checkStandard(P, tx, prevouts, label) {
    const { vsize, weight } = vsizeOf(P, tx);
    if (weight > MAX_STANDARD_WEIGHT) throw new Error(`bridge-burn: ${label} exceeds the standard weight`);
    if (tx.version !== 2) throw new Error(`bridge-burn: ${label} must be version 2`);
    for (const o of tx.outputs) if (o.value < P.DUST) throw new Error(`bridge-burn: ${label} has a dust output (${o.value} sats)`);
    const inSum = prevouts.reduce((s, p) => s + p.value, 0), outSum = tx.outputs.reduce((s, o) => s + o.value, 0);
    const fee = inSum - outSum;
    if (fee < vsize * MIN_RELAY_RATE) throw new Error(`bridge-burn: ${label} pays ${fee} sats for ${vsize} vB, under the minimum relay fee`);
    return { vsize, weight, fee };
  }

  // Build and sign the commit and reveal. Nothing is broadcast.
  async function buildBridgeBurnTxs({ prims, network = 'mainnet', snapshot = null, feeRate = null, fundingUtxos = null, isSpendable = null, ...args }) {
    const P = primsOf(prims);
    const snap = snapshot || await fetchBurnSnapshot({ network });
    const plan = planBridgeBurn({ ...args, snapshot: snap });
    const { liveIndex } = plan;
    const rate = Number(feeRate != null ? feeRate : await P.getFeeRate('priority'));
    if (!Number.isFinite(rate) || rate < MIN_RELAY_RATE) throw new Error(`bridge-burn: fee rate ${rate} sat/vB is below the minimum relay rate`);

    const { wallet } = P;
    const wpkhSpk = P.p2wpkhScript(wallet.pub);
    const envelopeScript = P.encodeEnvelopeScript(wallet.xonly(), P.hexToBytes(plan.envelope.replace(/^0x/, '')));
    checkEnvelopeScript(envelopeScript);
    const leaf = P.tapLeafHash(envelopeScript);
    const { Q_xonly, parity } = P.tweakedOutputKey(P.TAP_NUMS, leaf);
    const commitSpk = P.p2trScript(Q_xonly);
    const cb = P.controlBlock(P.TAP_NUMS, parity);
    const noteSpk = P.hexToBytes('5120' + plan.owner.slice(2));
    const noteTxid = String(args.note.txid).replace(/^0x/, '').toLowerCase();

    // The reveal's size does not depend on the commit txid or output values, so size it exactly before funding.
    const revealTx = {
      version: 2, locktime: 0,
      inputs: [
        { txid: '00'.repeat(32), vout: 0, sequence: 0xfffffffd, witness: [new Uint8Array(64), envelopeScript, cb] },
        { txid: noteTxid, vout: plan.spentVout, sequence: 0xfffffffd, witness: [new Uint8Array(64)] },
      ],
      outputs: [{ value: P.DUST, script: wpkhSpk }],
    };
    const revealFee = P.feeFor(vsizeOf(P, revealTx).vsize, rate);
    const commitValue = Math.max(P.DUST, revealFee + P.DUST - plan.sats);
    revealTx.outputs[0].value = commitValue + plan.sats - revealFee;

    // Fund the commit from plain sats only: never the note, another reflected note, a cBTC lock or a protected
    // outpoint — the reflection nullifies any live note a transaction spends, envelope or not.
    const candidates = (fundingUtxos || await P.getUtxos(wallet.address())).filter((u) => {
      const k = h32(pool.outpointKey(txidInternal(u.txid), u.vout));
      if (k === plan.noteKey || liveIndex.live.has(k) || liveIndex.locks.has(k)) return false;
      if (isProtectedOutpoint(u.txid, u.vout)) return false;
      return typeof isSpendable === 'function' ? !!isSpendable(u) : true;
    }).sort((a, b) => {
      const ac = a.status?.confirmed === false ? 0 : 1, bc = b.status?.confirmed === false ? 0 : 1;
      return ac !== bc ? bc - ac : b.value - a.value;
    });
    const picked = []; let total = 0; let commitFee = P.feeFor(P.estCommitVb(1), rate);
    for (const u of candidates) {
      if (total >= commitValue + commitFee + P.DUST) break;
      picked.push(u); total += u.value; commitFee = P.feeFor(P.estCommitVb(picked.length), rate);
    }
    if (!picked.length || total < commitValue + commitFee) throw new Error(`bridge-burn: insufficient plain sats (need ~${commitValue + commitFee}, have ${total})`);
    const change = total - commitValue - commitFee;
    const commitTx = {
      version: 2, locktime: 0,
      inputs: picked.map((u) => ({ txid: u.txid, vout: u.vout, sequence: 0xfffffffd, witness: [] })),
      outputs: [{ value: commitValue, script: commitSpk }],
    };
    if (change >= P.DUST) commitTx.outputs.push({ value: change, script: wpkhSpk });
    P.signCommitInputs(commitTx, picked, wpkhSpk);
    const commitTxid = P.txid(commitTx);
    const commitPrevouts = picked.map((u) => ({ value: u.value, script: u.scriptpubkey ? P.hexToBytes(u.scriptpubkey) : wpkhSpk }));
    const commitStd = checkStandard(P, commitTx, commitPrevouts, 'commit');

    revealTx.inputs[0].txid = commitTxid;
    const prevouts = [{ value: commitValue, script: commitSpk }, { value: plan.sats, script: noteSpk }];
    revealTx.inputs[0].witness = P.signTaprootScriptPathInput(revealTx, prevouts, envelopeScript, cb);
    revealTx.inputs[1].witness = P.signTaprootKeypathInput(revealTx, 1, prevouts, args.notePriv);
    const revealStd = checkStandard(P, revealTx, prevouts, 'reveal');
    if (revealStd.fee !== revealFee) throw new Error('bridge-burn: reveal fee drifted from its estimate');
    if (revealTx.inputs[0].witness[0].length > MAX_TAPSCRIPT_STACK_ITEM) throw new Error('bridge-burn: tapscript stack item over the policy limit');

    // Signatures verify under the keys the outputs commit to.
    const b2h = (b) => '0x' + P.bytesToHex(b);
    const sig0ok = verifySchnorr(revealTx.inputs[0].witness[0], P.tapSighash(revealTx, 0, prevouts, leaf, 0x00), wallet.xonly());
    const sig1ok = verifySchnorr(revealTx.inputs[1].witness[0], P.tapSighashKeyPath(revealTx, 1, prevouts, 0x00), P.hexToBytes(plan.owner.slice(2)));
    if (!sig0ok || !sig1ok) throw new Error('bridge-burn: a reveal signature does not verify');

    // Read the reveal back the way the reflection does: the envelope at vin[0], exactly one live note spent.
    const commitHex = P.bytesToHex(P.serializeTx(commitTx));
    const revealHex = P.bytesToHex(P.serializeTx(revealTx));
    const env = extractTaprootEnvelope(revealHex);
    const parsed = env && parseBurnEnvelope(env);
    if (!parsed || lc(env) !== lc(plan.envelope)) throw new Error('bridge-burn: the reveal does not carry the envelope at vin[0]');
    if (lc(parsed.nullifier) !== lc(plan.nullifier) || lc(parsed.asset) !== plan.asset || lc(parsed.dest) !== lc(plan.destLeaf) || lc(parsed.target) !== plan.chainBinding) {
      throw new Error('bridge-burn: the envelope read back from the reveal differs from the plan');
    }
    const liveSpends = (extractInputs(revealHex) || []).filter((i) => liveIndex.live.has(h32(pool.outpointKey(i.prevTxid, i.prevVout))));
    if (liveSpends.length !== 1 || h32(pool.outpointKey(liveSpends[0].prevTxid, liveSpends[0].prevVout)) !== plan.noteKey) {
      throw new Error('bridge-burn: the reveal must spend exactly the burned reflected note');
    }
    if ((extractInputs(commitHex) || []).some((i) => liveIndex.live.has(h32(pool.outpointKey(i.prevTxid, i.prevVout))))) {
      throw new Error('bridge-burn: the commit would spend a reflected note');
    }

    const { liveIndex: _drop, ...rest } = plan;
    return {
      plan: rest, commitTx, revealTx, commitHex, revealHex, commitTxid, revealTxid: P.txid(revealTx),
      commitFee: commitStd.fee, revealFee, feeRate: rate, revealVsize: revealStd.vsize, commitVsize: commitStd.vsize,
      envelopeScript: b2h(envelopeScript),
    };
  }

  // Build, sign and broadcast through the injected standard broadcaster (commit first, then the reveal, which
  // retries while the commit propagates). Returns what `bridgeMint` needs once the reflection folds the burn.
  async function broadcastBridgeBurn(args = {}) {
    const P = primsOf(args.prims);
    const b = await buildBridgeBurnTxs({ ...args, prims: P });
    await P.broadcast(b.commitHex);
    try {
      await P.broadcastWithRetry(b.revealHex);
    } catch (e) {
      // The commit is out; the same signed reveal can be rebroadcast as is.
      const err = new Error(`bridge-burn: commit ${b.commitTxid} broadcast, reveal failed: ${e && e.message ? e.message : e}`);
      err.commitTxid = b.commitTxid; err.revealHex = b.revealHex; err.revealTxid = b.revealTxid;
      throw err;
    }
    const p = b.plan;
    return {
      status: 'broadcast', commitTxid: b.commitTxid, revealTxid: b.revealTxid, commitHex: b.commitHex, revealHex: b.revealHex,
      commitFee: b.commitFee, revealFee: b.revealFee, feeRate: b.feeRate,
      burnId: p.burnId, nullifier: p.nullifier, destLeaf: p.destLeaf, sourceClass: p.sourceClass, fee: p.fee, dest: p.dest,
      // Pass to bridgeMint({ ...mintArgs, recovery }) once the reflection has folded the reveal's block.
      mintArgs: {
        chainBinding: p.chainBinding, asset: p.asset, spentTxid: p.spentTxid, spentVout: p.spentVout, sourceClass: p.sourceClass,
        burned: p.burned, dest: { value: p.dest.value, blinding: p.dest.blinding, owner: p.dest.owner },
      },
    };
  }

  return { fetchBurnSnapshot, planBridgeBurn: (a) => { const { liveIndex, ...r } = planBridgeBurn(a); return r; }, buildBridgeBurnTxs, broadcastBridgeBurn };
}
