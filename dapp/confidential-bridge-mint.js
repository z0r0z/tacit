
const SOURCE_DEPOSIT = 0, SOURCE_REFLECTED = 1, SOURCE_REFLECTED_BOUND = 2;
const BURN_SOURCE_REFLECTED = 1, BURN_SOURCE_DEPOSIT = 2;
const U64_MAX = (1n << 64n) - 1n;

export function feeIsQuantized(fee) {
  let f = BigInt(fee);
  if (f < 0n) return false;
  if (f === 0n) return true;
  while (f % 10n === 0n) f /= 10n;
  return f < 100n;
}

export function ladderFee(v) {
  const x = BigInt(v);
  if (x <= 0n) return 0n;
  let digits = 0n;
  for (let t = x; t > 0n; t /= 10n) digits += 1n;
  if (digits <= 2n) return x;
  const scale = 10n ** (digits - 2n);
  return ((x + scale - 1n) / scale) * scale;
}

export function destValueFor({ burnValue, fee = 0n }) {
  const v = BigInt(burnValue), f = BigInt(fee);
  if (!feeIsQuantized(f)) throw new Error(`bridge-mint: fee ${f} is not on the fee ladder (at most two significant digits)`);
  if (v <= 0n || v > U64_MAX) throw new Error('bridge-mint: burned value out of range');
  if (f >= v) throw new Error('bridge-mint: fee must be below the burned value');
  return v - f;
}

export function txidInternal(displayHex) {
  const h = String(displayHex).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('bridge-mint: txid must be 32 bytes of hex');
  return '0x' + h.match(/../g).reverse().join('').toLowerCase();
}

export function makeConfidentialBridgeMint({ pool, ct, relay = null, fetchImpl = null, relayBase = '', stealth = null, airdrop = null } = {}) {
  if (!pool) throw new Error('confidential-bridge-mint: pool is required');
  const hex32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const lc = (x) => String(x || '').toLowerCase();
  const ptHex = (P) => '0x' + Array.from(P.toRawBytes(true), (b) => b.toString(16).padStart(2, '0')).join('');
  const bytesHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const freshScalar = () => {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    const x = BigInt(bytesHex(b)) % SECP_N;
    return x === 0n ? 1n : x;
  };

  function sourceLeaf({ sourceClass, asset, cx, cy, owner, spentTxid, spentVout, chainBinding }) {
    switch (Number(sourceClass)) {
      case SOURCE_DEPOSIT: return pool.leaf(asset, cx, cy, pool.outpointKey(spentTxid, spentVout));
      case SOURCE_REFLECTED: return pool.btcNoteLeaf(asset, cx, cy, owner);
      case SOURCE_REFLECTED_BOUND: return pool.btcNoteLeafBound(asset, cx, cy, owner, chainBinding);
      default: throw new Error(`bridge-mint: unknown source class ${sourceClass}`);
    }
  }

  const bridgeMintError = (code, message) => Object.assign(new Error(`bridge-mint: ${message}`), { code });
  const needCt = () => { if (!ct) throw new Error('bridge-mint: ct is required to build a mint'); return ct; };

  function bridgeMintParts({ chainBinding, asset, spentTxid, spentVout, sourceClass, burned, dest }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(chainBinding))) throw new Error('bridge-mint: chainBinding required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(asset))) throw new Error('bridge-mint: asset required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spentTxid))) throw new Error('bridge-mint: spentTxid required (internal byte order)');
    const vout = Number(spentVout);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('bridge-mint: bad spentVout');
    const cls = Number(sourceClass);
    if (![SOURCE_DEPOSIT, SOURCE_REFLECTED, SOURCE_REFLECTED_BOUND].includes(cls)) throw new Error(`bridge-mint: unknown source class ${sourceClass}`);
    const c = needCt();
    const vIn = BigInt(burned.value), rIn = BigInt(burned.blinding);
    const vOut = BigInt(dest.value), rOut = BigInt(dest.blinding);
    if (vIn <= 0n || vIn > U64_MAX || vOut <= 0n || vOut > vIn) throw new Error('bridge-mint: destination value must be positive and at most the burned value');
    const fee = vIn - vOut;
    if (!feeIsQuantized(fee)) throw new Error(`bridge-mint: implied fee ${fee} (burned − destination) is not on the fee ladder`);
    const { cx: inCx, cy: inCy } = pool.commitXY(vIn, rIn);
    const { cx: outCx, cy: outCy } = pool.commitXY(vOut, rOut);
    const destLeaf = pool.leaf(asset, outCx, outCy, dest.owner);
    const inOwner = cls === SOURCE_DEPOSIT ? pool.outpointKey(spentTxid, vout) : burned.owner;
    const srcLeaf = sourceLeaf({ sourceClass: cls, asset, cx: inCx, cy: inCy, owner: burned.owner, spentTxid, spentVout: vout, chainBinding });
    const burnId = pool.bridgeBurnId(cls === SOURCE_DEPOSIT ? BURN_SOURCE_DEPOSIT : BURN_SOURCE_REFLECTED, spentTxid, vout, srcLeaf, chainBinding);
    const kernel = c.kernelSign({ inputs: [{ value: vIn, blinding: rIn }], outputs: [{ value: vOut, blinding: rOut }], fee, outLeaves: [] });
    const { proof: rangeProof } = c.rangeProve([vOut], [rOut]);
    const op = {
      chainBinding: lc(chainBinding), asset: lc(asset), sourceClass: cls, spentTxid: lc(spentTxid), spentVout: vout,
      input: { cx: inCx, cy: inCy, owner: inOwner },
      output: { cx: outCx, cy: outCy, owner: dest.owner },
      rangeProof: bytesHex(rangeProof), fee: fee.toString(), kernel: { R: ptHex(kernel.R), z: hex32(kernel.z) },
    };
    return { op, fee, destLeaf, nullifier: pool.nullifier(srcLeaf), burnId, sourceClass: cls, srcLeaf };
  }

  function prepareReflection(snapshot) {
    if (snapshot && snapshot.burns && snapshot.leafIndexOf) return snapshot;
    if (!snapshot || !Array.isArray(snapshot.noteLeaves) || !Array.isArray(snapshot.burnNodes)) throw new Error('bridge-mint: snapshot { noteLeaves, burnNodes } required');
    const burns = pool.makeUtxoAccumulator();
    burns.setNodes(snapshot.burnNodes);
    const leafIndexOf = new Map();
    snapshot.noteLeaves.forEach((l, i) => { if (!leafIndexOf.has(lc(l))) leafIndexOf.set(lc(l), i); });
    let tree = null;
    return { burns, leafIndexOf, burnRoot: burns.root(), noteLeaves: snapshot.noteLeaves, noteTree: () => { if (!tree) { tree = new pool.Tree(); for (const l of snapshot.noteLeaves) tree.insert(l); } return tree; } };
  }

  function bridgeMintIdentity(op) {
    const cls = Number(op && op.sourceClass);
    if (!op || !op.input || !op.output || ![SOURCE_DEPOSIT, SOURCE_REFLECTED, SOURCE_REFLECTED_BOUND].includes(cls)) throw bridgeMintError('bad_op', 'not a bridge mint op');
    const vout = Number(op.spentVout);
    const srcLeaf = sourceLeaf({ sourceClass: cls, asset: op.asset, cx: op.input.cx, cy: op.input.cy, owner: op.input.owner, spentTxid: op.spentTxid, spentVout: vout, chainBinding: op.chainBinding });
    const burnId = pool.bridgeBurnId(cls === SOURCE_DEPOSIT ? BURN_SOURCE_DEPOSIT : BURN_SOURCE_REFLECTED, op.spentTxid, vout, srcLeaf, op.chainBinding);
    return { srcLeaf, burnId, destLeaf: pool.leaf(op.asset, op.output.cx, op.output.cy, op.output.owner), nullifier: pool.nullifier(srcLeaf) };
  }

  function completeBridgeMintOp(op, reflection) {
    const r = prepareReflection(reflection);
    const { srcLeaf, burnId, destLeaf, nullifier } = bridgeMintIdentity(op);
    const leafIndex = r.leafIndexOf.get(lc(srcLeaf));
    if (leafIndex == null) throw bridgeMintError('note_not_in_tree', 'the burned note is not in the reflected note tree (yet), or the opening/outpoint does not match it');
    if (!r.burns.contains(burnId)) throw bridgeMintError('burn_not_recorded', 'the burn is not recorded in the reflected state yet');
    const bm = r.burns.membershipWitness(burnId);
    if (lc(bm.value) !== lc(destLeaf)) throw bridgeMintError('dest_mismatch', 'the burn committed to a different destination than the one given (check dest value/blinding/owner — the destination value is the burned value net of the fee)');
    const { root: poolRoot, path: inPath } = r.noteTree().rootAndPath(leafIndex);
    const done = {
      ...op,
      bitcoinBurnRoot: r.burnRoot,
      poolRoot,
      input: { ...op.input, leafIndex, path: inPath },
      burnMembership: { next: bm.next, index: bm.index, path: bm.path },
    };
    return { op: done, burnId, destLeaf, srcLeaf, nullifier, burnRoot: r.burnRoot, poolRoot };
  }

  function verifyBridgeMintParts(op) {
    try {
      const c = needCt();
      const hexBytes = (h) => Uint8Array.from((String(h).replace(/^0x/, '').match(/../g) || []).map((x) => parseInt(x, 16)));
      const fee = BigInt(op.fee);
      if (!feeIsQuantized(fee)) return { ok: false, reason: 'the fee is not on the fee ladder' };
      const inC = [c.pointOf(op.input.cx, op.input.cy)], outC = [c.pointOf(op.output.cx, op.output.cy)];
      const kernel = { R: c.pointFromHex(op.kernel.R), z: BigInt(op.kernel.z) };
      const ok = c.verifyTransfer({ inC, outC, rangeProof: hexBytes(op.rangeProof), kernel, fee, outLeaves: [] });
      return ok ? { ok: true } : { ok: false, reason: 'the range proof or the conservation kernel does not verify' };
    } catch (e) { return { ok: false, reason: `not a readable mint (${(e && e.message) || e})` }; }
  }

  function buildBridgeMintOp({ chainBinding, asset, spentTxid, spentVout, sourceClass, burned, dest, snapshot }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(chainBinding))) throw new Error('bridge-mint: chainBinding required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(asset))) throw new Error('bridge-mint: asset required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spentTxid))) throw new Error('bridge-mint: spentTxid required (internal byte order)');
    const vout = Number(spentVout);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('bridge-mint: bad spentVout');
    if (!snapshot || !Array.isArray(snapshot.noteLeaves) || !Array.isArray(snapshot.burnNodes)) throw new Error('bridge-mint: snapshot { noteLeaves, burnNodes } required');
    const vIn = BigInt(burned.value), rIn = BigInt(burned.blinding);
    const vOut = BigInt(dest.value);
    if (vIn <= 0n || vIn > U64_MAX || vOut <= 0n || vOut > vIn) throw new Error('bridge-mint: destination value must be positive and at most the burned value');
    const fee = vIn - vOut;
    if (!feeIsQuantized(fee)) throw new Error(`bridge-mint: implied fee ${fee} (burned − destination) is not on the fee ladder`);

    const { cx: inCx, cy: inCy } = pool.commitXY(vIn, rIn);
    const r = prepareReflection(snapshot);
    const classes = sourceClass == null ? [SOURCE_REFLECTED_BOUND, SOURCE_REFLECTED, SOURCE_DEPOSIT] : [Number(sourceClass)];
    let cls = null;
    for (const c of classes) {
      const srcLeaf = sourceLeaf({ sourceClass: c, asset, cx: inCx, cy: inCy, owner: burned.owner, spentTxid, spentVout: vout, chainBinding });
      if (!r.leafIndexOf.has(lc(srcLeaf))) continue;
      if (!r.burns.contains(pool.bridgeBurnId(c === SOURCE_DEPOSIT ? BURN_SOURCE_DEPOSIT : BURN_SOURCE_REFLECTED, spentTxid, vout, srcLeaf, chainBinding))) continue;
      cls = c;
      break;
    }
    if (cls == null) throw new Error('bridge-mint: burn not found in the reflected state yet (the burned note or its burn record is not folded), or the opening/outpoint does not match it');
    const parts = bridgeMintParts({ chainBinding, asset, spentTxid, spentVout: vout, sourceClass: cls, burned, dest });
    const done = completeBridgeMintOp(parts.op, r);
    return { op: done.op, fee, destLeaf: parts.destLeaf, nullifier: parts.nullifier, burnId: parts.burnId, sourceClass: cls };
  }

  // `stealthDest(nullifier, vOut)` (pay-to-stealth) names the burn's destination as a stealth lock for someone else, built by
  // stealthDestFor from the nullifier this burn will carry; the envelope then pins the lock's leaf instead of a note's.
  function buildBridgeBurnEnvelope({ asset, bitcoinPoolRoot, chainBinding, sourceClass = SOURCE_REFLECTED_BOUND, burned, fee = 0n, dest, deriveDestBlinding = null, stealthDest = null }) {
    const cls = Number(sourceClass);
    if (cls !== SOURCE_REFLECTED && cls !== SOURCE_REFLECTED_BOUND) throw new Error('bridge-mint: the envelope builder covers reflected notes (class 1 or 2); a burn-deposit has its own path');
    for (const [k, v] of [['asset', asset], ['bitcoinPoolRoot', bitcoinPoolRoot], ['chainBinding', chainBinding], ['burned.owner', burned && burned.owner], ...(stealthDest ? [] : [['dest.owner', dest && dest.owner]])]) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(v))) throw new Error(`bridge-mint: ${k} must be 32 bytes of hex`);
    }
    const vOut = destValueFor({ burnValue: burned.value, fee });
    const { cx, cy } = pool.commitXY(BigInt(burned.value), BigInt(burned.blinding));
    const srcLeaf = sourceLeaf({ sourceClass: cls, asset, cx, cy, owner: burned.owner, chainBinding });
    const nullifier = pool.nullifier(srcLeaf);
    let destLeaf, destOut;
    if (typeof stealthDest === 'function') {
      const sd = stealthDest(nullifier, vOut);
      if (!sd || BigInt(sd.value) !== vOut) throw new Error('bridge-mint: the stealth destination must hold the burned value net of the fee');
      destLeaf = sd.lockLeaf;
      destOut = { value: vOut, blinding: BigInt(sd.lBlinding), owner: sd.ownerPub, cx: sd.cx, cy: sd.cy, stealth: sd };
    } else {
      const rDest = BigInt(dest.blinding != null ? dest.blinding : typeof deriveDestBlinding === 'function' ? deriveDestBlinding(nullifier) : 0n);
      if (rDest <= 0n) throw new Error('bridge-mint: dest.blinding or deriveDestBlinding required');
      const d = pool.commitXY(vOut, rDest);
      destLeaf = pool.leaf(asset, d.cx, d.cy, dest.owner);
      destOut = { value: vOut, blinding: rDest, owner: dest.owner, cx: d.cx, cy: d.cy };
    }
    const envelope = '0x2b' + [asset, bitcoinPoolRoot, nullifier, destLeaf, chainBinding].map((h) => String(h).replace(/^0x/, '').toLowerCase()).join('');
    return { envelope, nullifier, destLeaf, fee: BigInt(fee), dest: destOut };
  }

  // ---- Pay-to-stealth: a burn that pays someone else (OP_BRIDGE_STEALTH_MINT) ----
  // The burn pins destLeaf = stealth_lock_leaf_blind(asset, L, ownerPub, deadline, refundPub) as its destination and the mint puts
  // that lock in the shared lock-set: only the recipient's one-time key can claim it (OP_STEALTH_CLAIM), and the burner's refund key
  // takes it back after the deadline (OP_STEALTH_REFUND). The ephemeral key, L's blinding and the refund key are all derived from
  // the burner's key and the burn's nullifier (the airdrop's derivations), so a lost page costs nothing the key cannot rebuild.
  const ZERO32 = '0x' + '00'.repeat(32);
  const STEALTH_LOCK_DAYS = 90;
  const needStealth = () => {
    if (!stealth || !airdrop) throw new Error('bridge-mint: paying a stealth address needs the stealth and airdrop helpers wired');
    return { S: stealth, A: airdrop };
  };
  // A deadline on a whole UTC day, `days` ahead: the same burn rebuilt after a reload lands on the same day, and a burn found on
  // Bitcoin later can be matched by trying the few days around its block time (stealthDeadlineCandidates).
  const stealthDeadline = (nowSec, days = STEALTH_LOCK_DAYS) => (Math.floor(Number(nowSec) / 86400) + days) * 86400;
  const stealthDeadlineCandidates = (burnSec, days = STEALTH_LOCK_DAYS) => {
    const day = Math.floor(Number(burnSec) / 86400);
    return [-3, -2, -1, 0, 1, 2].map((d) => (day + d + days) * 86400);
  };
  function stealthDestFor({ asset, lockerScanPriv, nullifier, recipientSpendPub, value, deadline }) {
    const { S, A } = needStealth();
    const v = BigInt(value), dl = BigInt(deadline);
    if (v <= 0n || v > U64_MAX) throw new Error('bridge-mint: stealth value out of range');
    if (dl <= 0n) throw new Error('bridge-mint: a stealth lock needs a deadline');
    if (!/^0x0[23][0-9a-fA-F]{64}$/.test(String(recipientSpendPub))) throw new Error('bridge-mint: the recipient must be a 33-byte compressed public key');
    const ePriv = A.ephPriv(lockerScanPriv, recipientSpendPub, 0, nullifier);
    const { ephemeralPub, ownerPub } = S.oneTimeAddress({ recipientSpendPub, ephemeralPriv: ePriv });
    const lBlinding = A.lockBlinding(lockerScanPriv, 0, nullifier);
    const rPriv = A.refundPriv(lockerScanPriv, 0, nullifier);
    const refundPub = A.refundPubOf(rPriv);
    const { cx, cy } = pool.commitXY(v, BigInt(lBlinding));
    const lockLeaf = S.stealthLockLeafBlind(asset, cx, cy, ownerPub, dl, refundPub);
    return { asset: lc(asset), recipientSpendPub: lc(recipientSpendPub), ephemeralPriv: hex32(ePriv), ephemeralPub, ownerPub, lBlinding, refundPriv: hex32(rPriv), refundPub, deadline: dl, value: v, cx, cy, lockLeaf };
  }

  // Memo for the lock: the recipient's half (the opening they need to claim) and the burner's tail (so "take back a private send"
  // finds the lock from the key alone). The contract wants one memo per lock leaf.
  function sealStealthLockMemo({ lockerScanPriv, stealthDest: sd }) {
    const { A } = needStealth();
    const recipientMemo = A.sealStealthMemo({ recipientSpendPub: sd.recipientSpendPub, ephemeralPriv: sd.ephemeralPriv, asset: sd.asset, amount: sd.value, lBlinding: sd.lBlinding, deadline: sd.deadline, refundPub: sd.refundPub });
    const tail = A.sealStealthSenderTail({ senderPriv: lockerScanPriv, ephemeralPub: sd.ephemeralPub, asset: sd.asset, amount: sd.value, lBlinding: sd.lBlinding, deadline: sd.deadline, refundPriv: sd.refundPriv, ownerPub: sd.ownerPub, recipientPub: sd.recipientSpendPub });
    return recipientMemo + String(tail).replace(/^0x/, '');
  }

  function bridgeStealthMintParts({ chainBinding, asset, spentTxid, spentVout, sourceClass, burned, stealthDest: sd }) {
    const { S } = needStealth();
    const vout = Number(spentVout);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('bridge-mint: bad spentVout');
    const cls = Number(sourceClass);
    if (![SOURCE_DEPOSIT, SOURCE_REFLECTED, SOURCE_REFLECTED_BOUND].includes(cls)) throw new Error(`bridge-mint: unknown source class ${sourceClass}`);
    const vIn = BigInt(burned.value), rIn = BigInt(burned.blinding), vOut = BigInt(sd.value);
    if (vIn <= 0n || vIn > U64_MAX || vOut <= 0n || vOut > vIn) throw new Error('bridge-mint: destination value must be positive and at most the burned value');
    const fee = vIn - vOut;
    if (!feeIsQuantized(fee)) throw new Error(`bridge-mint: implied fee ${fee} (burned − destination) is not on the fee ladder`);
    const { cx: inCx, cy: inCy } = pool.commitXY(vIn, rIn);
    const srcLeaf = sourceLeaf({ sourceClass: cls, asset, cx: inCx, cy: inCy, owner: burned.owner, spentTxid, spentVout: vout, chainBinding });
    const burnId = pool.bridgeBurnId(cls === SOURCE_DEPOSIT ? BURN_SOURCE_DEPOSIT : BURN_SOURCE_REFLECTED, spentTxid, vout, srcLeaf, chainBinding);
    const lockLeaf = S.stealthLockLeafBlind(asset, sd.cx, sd.cy, sd.ownerPub, sd.deadline, sd.refundPub);
    if (lc(lockLeaf) !== lc(sd.lockLeaf)) throw new Error('bridge-mint: the stealth destination does not match its own lock leaf');
    const op = S.buildBridgeStealthMint({
      chainBinding, bitcoinBurnRoot: ZERO32, asset, poolRoot: ZERO32,
      burned: { cx: inCx, cy: inCy, owner: burned.owner, blinding: rIn, sourceClass: cls, spentTxid, spentVout: vout, leafIndex: 0, path: [] },
      ownerPub: sd.ownerPub, amount: vIn, deadline: sd.deadline, locker: sd.refundPub, lBlinding: sd.lBlinding,
      bmNext: ZERO32, bmIndex: 0, bmPath: [], fee,
    });
    if (lc(op.lCx) !== lc(sd.cx) || lc(op.lCy) !== lc(sd.cy)) throw new Error('bridge-mint: the stealth mint\'s lock commitment is not the one the burn pinned');
    return { op, fee, destLeaf: lockLeaf, nullifier: pool.nullifier(srcLeaf), burnId, sourceClass: cls, srcLeaf };
  }

  // The public half, read off the reflected state: the burned note's place in the note tree and the burn's place in the burn set,
  // which must hold exactly the stealth lock this mint creates.
  function completeBridgeStealthMintOp(op, reflection) {
    const r = prepareReflection(reflection);
    const cls = Number(op.sourceClass);
    const srcLeaf = sourceLeaf({ sourceClass: cls, asset: op.asset, cx: op.inCx, cy: op.inCy, owner: op.inOwner, spentTxid: op.spentTxid, spentVout: Number(op.spentVout), chainBinding: op.chainBinding });
    const burnId = pool.bridgeBurnId(cls === SOURCE_DEPOSIT ? BURN_SOURCE_DEPOSIT : BURN_SOURCE_REFLECTED, op.spentTxid, Number(op.spentVout), srcLeaf, op.chainBinding);
    const destLeaf = needStealth().S.stealthLockLeafBlind(op.asset, op.lCx, op.lCy, op.ownerPub, op.deadline, op.locker);
    const leafIndex = r.leafIndexOf.get(lc(srcLeaf));
    if (leafIndex == null) throw bridgeMintError('note_not_in_tree', 'the burned note is not in the reflected note tree (yet), or the opening/outpoint does not match it');
    if (!r.burns.contains(burnId)) throw bridgeMintError('burn_not_recorded', 'the burn is not recorded in the reflected state yet');
    const bm = r.burns.membershipWitness(burnId);
    if (lc(bm.value) !== lc(destLeaf)) throw bridgeMintError('dest_mismatch', 'the burn committed to a different destination than this stealth lock (check the recipient and the deadline)');
    const { root: poolRoot, path: inPath } = r.noteTree().rootAndPath(leafIndex);
    return { op: { ...op, bitcoinBurnRoot: r.burnRoot, poolRoot, inIndex: leafIndex, inPath, bmNext: bm.next, bmIndex: bm.index, bmPath: bm.path }, burnId, destLeaf, srcLeaf, burnRoot: r.burnRoot, poolRoot };
  }

  function buildBridgeStealthMintOp({ chainBinding, asset, spentTxid, spentVout, sourceClass, burned, stealthDest: sd, snapshot }) {
    if (!snapshot || !Array.isArray(snapshot.noteLeaves) || !Array.isArray(snapshot.burnNodes)) throw new Error('bridge-mint: snapshot { noteLeaves, burnNodes } required');
    const r = prepareReflection(snapshot);
    const parts = bridgeStealthMintParts({ chainBinding, asset, spentTxid, spentVout, sourceClass: sourceClass == null ? SOURCE_REFLECTED : sourceClass, burned, stealthDest: sd });
    if (!r.leafIndexOf.has(lc(parts.srcLeaf)) || !r.burns.contains(parts.burnId)) {
      throw new Error('bridge-mint: burn not found in the reflected state yet (the burned note or its burn record is not folded), or the opening/outpoint does not match it');
    }
    const done = completeBridgeStealthMintOp(parts.op, r);
    return { op: done.op, fee: parts.fee, destLeaf: parts.destLeaf, nullifier: parts.nullifier, burnId: parts.burnId, sourceClass: parts.sourceClass };
  }

  // Settle a stealth mint: the same loop as bridgeMint (a stale burn root is rebuilt from a fresh dump), with the lock memo in place
  // of a note memo. `lockerScanPriv` is the burner's key as the sent-lock scan reads it (identity(walletPriv).priv, hex).
  async function bridgeStealthMint({ network = 'mainnet', snapshot = null, lockerScanPriv, stealthDest: sd, waitOpts, selfSettle = null, staleDelayMs = 4000, ...args }) {
    if (!relay) throw new Error('bridge-mint: no relay wired');
    if (!lockerScanPriv) throw new Error('bridge-mint: the burner\'s key is needed to seal the lock memo');
    for (let attempt = 0; ; attempt++) {
      const snap = snapshot && attempt === 0 ? snapshot : await fetchReflectionSnapshot({ network });
      const built = buildBridgeStealthMintOp({ ...args, stealthDest: sd, snapshot: snap });
      const memo = sealStealthLockMemo({ lockerScanPriv, stealthDest: sd });
      const spec = { type: 'bridgestealthmint', op: built.op, lockMemos: [memo] };
      try {
        if (!selfSettle) return { ...(await relay.settle(spec, waitOpts)), ...built, lockMemo: memo };
        const proven = await relay.prove(spec, waitOpts);
        if (proven.status === 'settled') return { ...proven, ...built, lockMemo: memo };
        if (proven.status !== 'proven') throw new Error(`bridge-mint: the relay could not prove this mint (${proven.error || proven.status})`);
        const sent = await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos: proven.memos && proven.memos.length ? proven.memos : [memo] });
        return { jobId: proven.jobId, ...sent, ...built, lockMemo: memo };
      } catch (e) {
        if (!(e && e.code === 'stale_root') || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, staleDelayMs * (attempt + 1)));
      }
    }
  }

  async function fetchReflectionSnapshot({ network = 'mainnet' } = {}) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? (u, i) => (globalThis.__tacitRelayFetch || fetch)(u, i) : null);
    if (!f) throw new Error('bridge-mint: no fetch available');
    const root = String(relayBase || '').replace(/\/$/, '');
    const res = await f(`${root}/reflection/dump?network=${network === 'signet' ? 'signet' : 'mainnet'}`);
    if (!res.ok) throw new Error(`bridge-mint: reflection dump ${res.status}`);
    const j = await res.json();
    const snap = j && j.snapshot;
    if (!snap || !Array.isArray(snap.noteLeaves) || !Array.isArray(snap.burnNodes)) throw new Error('bridge-mint: reflection dump carries no note tree / burn set');
    return { noteLeaves: snap.noteLeaves, burnNodes: snap.burnNodes, height: j.attestedHeight ?? snap.height ?? null };
  }

  function outputFor(recovery, dest, op) {
    return recovery.seedDerived
      ? { seedDerived: true }
      : { ownerPub: recovery.ownerPub, value: String(dest.value), blinding: hex32(dest.blinding), secret: recovery.secret == null ? 0 : recovery.secret,
          asset: op.asset, owner: dest.owner, cx: op.output.cx, cy: op.output.cy };
  }

  async function armMint({ network = 'mainnet', recovery, ephRand, ...args }) {
    if (!relay || typeof relay.sealFor !== 'function') throw new Error('bridge-mint: no relay wired');
    if (!recovery || (!recovery.seedDerived && recovery.ownerPub == null)) throw new Error('bridge-mint: pass recovery { ownerPub, secret } or { seedDerived: true } so the minted note stays recoverable');
    const f = fetchImpl || (typeof fetch !== 'undefined' ? (u, i) => (globalThis.__tacitRelayFetch || fetch)(u, i) : null);
    if (!f) throw new Error('bridge-mint: no fetch available');
    const parts = bridgeMintParts(args);
    const memos = relay.sealFor({ leaves: [parts.destLeaf], outputs: [outputFor(recovery, args.dest, parts.op)], ephRand: ephRand || freshScalar });
    const root = String(relayBase || '').replace(/\/$/, '');
    const res = await f(`${root}/confidential/arm?network=${network === 'signet' ? 'signet' : 'mainnet'}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'bridgemint', op: parts.op, memos }) });
    const j = await res.json().catch(() => null);
    if (!res.ok || !j || !j.ok) return { ok: false, code: (j && j.code) || `http_${res.status}`, error: (j && j.error) || `the relay answered ${res.status}`, dest: parts.destLeaf };
    return { ok: true, status: j.status, jobId: j.jobId || null, dest: parts.destLeaf };
  }
  async function armedStatus(dest, { network = 'mainnet' } = {}) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? (u, i) => (globalThis.__tacitRelayFetch || fetch)(u, i) : null);
    if (!f) throw new Error('bridge-mint: no fetch available');
    const root = String(relayBase || '').replace(/\/$/, '');
    const res = await f(`${root}/confidential/armed?dest=${encodeURIComponent(dest)}&network=${network === 'signet' ? 'signet' : 'mainnet'}`);
    if (!res.ok) throw new Error(`bridge-mint: armed status ${res.status}`);
    const j = await res.json();
    return { status: (j && j.status) || 'unknown', jobId: (j && j.jobId) || null };
  }

  async function bridgeMint({ network = 'mainnet', snapshot = null, recovery, ephRand, waitOpts, selfSettle = null, staleDelayMs = 4000, ...args }) {
    if (!relay) throw new Error('bridge-mint: no relay wired');
    if (!recovery || (!recovery.seedDerived && recovery.ownerPub == null)) {
      throw new Error('bridge-mint: pass recovery { ownerPub, secret } or { seedDerived: true } so the minted note stays recoverable');
    }
    for (let attempt = 0; ; attempt++) {
      const snap = snapshot && attempt === 0 ? snapshot : await fetchReflectionSnapshot({ network });
      const built = buildBridgeMintOp({ ...args, snapshot: snap });
      const output = outputFor(recovery, args.dest, built.op);
      const spec = { type: 'bridgemint', op: built.op, leaves: [built.destLeaf], outputs: [output], ephRand: ephRand || freshScalar };
      try {
        if (!selfSettle) return { ...(await relay.settle(spec, waitOpts)), ...built };
        const proven = await relay.prove(spec, waitOpts);
        if (proven.status === 'settled') return { ...proven, ...built };
        if (proven.status !== 'proven') throw new Error(`bridge-mint: the relay could not prove this mint (${proven.error || proven.status})`);
        const sent = await selfSettle({ jobId: proven.jobId, publicValues: proven.publicValues, proof: proven.proof, memos: proven.memos || [] });
        return { jobId: proven.jobId, ...sent, ...built };
      } catch (e) {
        if (!(e && e.code === 'stale_root') || attempt >= 2) throw e;
        await new Promise((r) => setTimeout(r, staleDelayMs * (attempt + 1)));
      }
    }
  }

  return { sourceLeaf, buildBridgeBurnEnvelope, buildBridgeMintOp, bridgeMintParts, bridgeMintIdentity, armMint, armedStatus, prepareReflection, completeBridgeMintOp, verifyBridgeMintParts, fetchReflectionSnapshot, bridgeMint, feeIsQuantized, ladderFee, destValueFor, txidInternal,
    stealthDestFor, stealthDeadline, stealthDeadlineCandidates, sealStealthLockMemo, bridgeStealthMintParts, completeBridgeStealthMintOp, buildBridgeStealthMintOp, bridgeStealthMint };
}
