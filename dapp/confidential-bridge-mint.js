// OP_BRIDGE_MINT client: mint the Ethereum note for a Bitcoin note burned for the bridge (BTC→ETH), and hand it
// to the relay so a holder with no ETH can complete the mint.
//
// The destination is fixed at burn time: the 0x2B burn envelope pins destLeaf = leaf(asset, Cx, Cy, owner) of the
// Ethereum note, and the reflection records burnId → destLeaf in the bridge-burn set. The mint proves
// v_burn == v_out + fee, so a relay fee is chosen when the burn is BUILT: commit the destination to
// v_burn − fee (see `destValueFor`), and the mint pays exactly that fee to whoever settles it. A destination
// committed to the full burned value mints with fee 0 (self-settle, or the relay's free budget).
//
// The op JSON matches contracts/sp1/confidential/harnesses/exec-bridgemint.rs (the relay writes it verbatim to the
// harness OP_FILE): chainBinding ‖ bitcoinBurnRoot ‖ asset ‖ poolRoot ‖ sourceClass ‖ spentTxid ‖ spentVout ‖
// input{cx,cy,owner,leafIndex,path} ‖ output{cx,cy,owner} ‖ burnMembership{next,index,path} ‖ rangeProof ‖ fee ‖
// kernel{R,z}. The kernel is the unbound conservation kernel over [C_burn] → [C_dest] with the public fee
// (verify_kernel_with_fee), so only the holder of both openings can sign it.
//
// Witness data (the Bitcoin note tree and the bridge-burn set) comes from the relay's public reflected-state
// export, GET /reflection/dump. The mint must prove against the burn root the pool currently holds, so a mint
// built just before a newer reflection lands is refused on-chain as stale; rebuild it from a fresh dump.
//
// Deps: { pool } — makeConfidentialPool(); { ct } — makeConfidentialTransfer(); { relay } — makeConfidentialRelay()
// (for `bridgeMint`); { fetchImpl, relayBase } — for `fetchReflectionSnapshot`.

const SOURCE_DEPOSIT = 0, SOURCE_REFLECTED = 1, SOURCE_REFLECTED_BOUND = 2;
const BURN_SOURCE_REFLECTED = 1, BURN_SOURCE_DEPOSIT = 2;
const U64_MAX = (1n << 64n) - 1n;

// A relay fee must be zero or carry at most two significant decimal digits (the guest's fee_is_quantized).
export function feeIsQuantized(fee) {
  let f = BigInt(fee);
  if (f < 0n) return false;
  if (f === 0n) return true;
  while (f % 10n === 0n) f /= 10n;
  return f < 100n;
}

// Round a fee UP onto the two-significant-digit ladder (never below the amount it was derived from).
export function ladderFee(v) {
  const x = BigInt(v);
  if (x <= 0n) return 0n;
  let digits = 0n;
  for (let t = x; t > 0n; t /= 10n) digits += 1n;
  if (digits <= 2n) return x;
  const scale = 10n ** (digits - 2n);
  return ((x + scale - 1n) / scale) * scale;
}

// The value to commit the Ethereum destination to when burning `burnValue` with relay fee `fee`.
export function destValueFor({ burnValue, fee = 0n }) {
  const v = BigInt(burnValue), f = BigInt(fee);
  if (!feeIsQuantized(f)) throw new Error(`bridge-mint: fee ${f} is not on the fee ladder (at most two significant digits)`);
  if (v <= 0n || v > U64_MAX) throw new Error('bridge-mint: burned value out of range');
  if (f >= v) throw new Error('bridge-mint: fee must be below the burned value');
  return v - f;
}

// Display (RPC / explorer) txid → the internal byte order the guest and burnId use.
export function txidInternal(displayHex) {
  const h = String(displayHex).replace(/^0x/, '');
  if (!/^[0-9a-fA-F]{64}$/.test(h)) throw new Error('bridge-mint: txid must be 32 bytes of hex');
  return '0x' + h.match(/../g).reverse().join('').toLowerCase();
}

export function makeConfidentialBridgeMint({ pool, ct, relay = null, fetchImpl = null, relayBase = '' } = {}) {
  if (!pool || !ct) throw new Error('confidential-bridge-mint: pool and ct are required');
  const hex32 = (v) => '0x' + BigInt(v).toString(16).padStart(64, '0');
  const lc = (x) => String(x || '').toLowerCase();
  const ptHex = (P) => '0x' + Array.from(P.toRawBytes(true), (b) => b.toString(16).padStart(2, '0')).join('');
  const bytesHex = (b) => '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  // A fresh memo ephemeral scalar in (0, n), for callers that do not supply their own source.
  const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const freshScalar = () => {
    const b = new Uint8Array(32);
    globalThis.crypto.getRandomValues(b);
    const x = BigInt(bytesHex(b)) % SECP_N;
    return x === 0n ? 1n : x;
  };

  // The burned note's leaf in the reflected Bitcoin note tree, per source class (mirrors OP_BRIDGE_MINT):
  //   0 — burn-deposit native note, owned by its own burned outpoint: leaf(asset, cx, cy, outpointKey)
  //   1 — reflected note (legacy domain):                               btc_note_leaf(asset, cx, cy, authKey)
  //   2 — reflected note bound to this deployment:                      btc_note_leaf_bound(..., chainBinding)
  function sourceLeaf({ sourceClass, asset, cx, cy, owner, spentTxid, spentVout, chainBinding }) {
    switch (Number(sourceClass)) {
      case SOURCE_DEPOSIT: return pool.leaf(asset, cx, cy, pool.outpointKey(spentTxid, spentVout));
      case SOURCE_REFLECTED: return pool.btcNoteLeaf(asset, cx, cy, owner);
      case SOURCE_REFLECTED_BOUND: return pool.btcNoteLeafBound(asset, cx, cy, owner, chainBinding);
      default: throw new Error(`bridge-mint: unknown source class ${sourceClass}`);
    }
  }

  // Build the OP_BRIDGE_MINT op for a burn the reflection has folded.
  //   burned   { value, blinding, owner } — the burned Bitcoin note's opening; owner is its x-only Taproot key
  //            (classes 1/2; ignored for class 0, whose owner is its outpoint key)
  //   dest     { value, blinding, owner } — the destination the burn committed to (owner = the Ethereum note owner)
  //   spentTxid/spentVout — the burned note's outpoint (internal byte order; see txidInternal)
  //   sourceClass — 0/1/2, or omitted to take whichever class's leaf and burnId the snapshot actually holds
  //   snapshot { noteLeaves, burnNodes } — from fetchReflectionSnapshot
  // Returns { op, fee, destLeaf, nullifier, burnId, sourceClass }. The fee is burned.value − dest.value, and must be
  // on the fee ladder; the destination must be exactly the one recorded for this burn, or the build refuses.
  function buildBridgeMintOp({ chainBinding, asset, spentTxid, spentVout, sourceClass, burned, dest, snapshot }) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(chainBinding))) throw new Error('bridge-mint: chainBinding required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(asset))) throw new Error('bridge-mint: asset required');
    if (!/^0x[0-9a-fA-F]{64}$/.test(String(spentTxid))) throw new Error('bridge-mint: spentTxid required (internal byte order)');
    const vout = Number(spentVout);
    if (!Number.isInteger(vout) || vout < 0 || vout > 0xffffffff) throw new Error('bridge-mint: bad spentVout');
    if (!snapshot || !Array.isArray(snapshot.noteLeaves) || !Array.isArray(snapshot.burnNodes)) throw new Error('bridge-mint: snapshot { noteLeaves, burnNodes } required');
    const vIn = BigInt(burned.value), rIn = BigInt(burned.blinding);
    const vOut = BigInt(dest.value), rOut = BigInt(dest.blinding);
    if (vIn <= 0n || vIn > U64_MAX || vOut <= 0n || vOut > vIn) throw new Error('bridge-mint: destination value must be positive and at most the burned value');
    const fee = vIn - vOut;
    if (!feeIsQuantized(fee)) throw new Error(`bridge-mint: implied fee ${fee} (burned − destination) is not on the fee ladder`);

    const { cx: inCx, cy: inCy } = pool.commitXY(vIn, rIn);
    const { cx: outCx, cy: outCy } = pool.commitXY(vOut, rOut);
    const destLeaf = pool.leaf(asset, outCx, outCy, dest.owner);

    const burns = pool.makeUtxoAccumulator();
    burns.setNodes(snapshot.burnNodes);
    const leafIndexOf = new Map();
    snapshot.noteLeaves.forEach((l, i) => { if (!leafIndexOf.has(lc(l))) leafIndexOf.set(lc(l), i); });

    const classes = sourceClass == null ? [SOURCE_REFLECTED_BOUND, SOURCE_REFLECTED, SOURCE_DEPOSIT] : [Number(sourceClass)];
    let found = null;
    for (const cls of classes) {
      const srcLeaf = sourceLeaf({ sourceClass: cls, asset, cx: inCx, cy: inCy, owner: burned.owner, spentTxid, spentVout: vout, chainBinding });
      const leafIndex = leafIndexOf.get(lc(srcLeaf));
      if (leafIndex == null) continue;
      const burnId = pool.bridgeBurnId(cls === SOURCE_DEPOSIT ? BURN_SOURCE_DEPOSIT : BURN_SOURCE_REFLECTED, spentTxid, vout, srcLeaf, chainBinding);
      if (!burns.contains(burnId)) continue;
      found = { cls, srcLeaf, leafIndex, burnId };
      break;
    }
    if (!found) throw new Error('bridge-mint: burn not found in the reflected state yet (the burned note or its burn record is not folded), or the opening/outpoint does not match it');
    const bm = burns.membershipWitness(found.burnId);
    if (lc(bm.value) !== lc(destLeaf)) {
      throw new Error('bridge-mint: the burn committed to a different destination than the one given (check dest value/blinding/owner — the destination value is the burned value net of the fee)');
    }

    const tree = new pool.Tree();
    for (const l of snapshot.noteLeaves) tree.insert(l);
    const { root: poolRoot, path: inPath } = tree.rootAndPath(found.leafIndex);

    const kernel = ct.kernelSign({ inputs: [{ value: vIn, blinding: rIn }], outputs: [{ value: vOut, blinding: rOut }], fee, outLeaves: [] });
    const { proof: rangeProof } = ct.rangeProve([vOut], [rOut]);
    const inOwner = found.cls === SOURCE_DEPOSIT ? pool.outpointKey(spentTxid, vout) : burned.owner;

    const op = {
      chainBinding: lc(chainBinding),
      bitcoinBurnRoot: burns.root(),
      asset: lc(asset),
      poolRoot,
      sourceClass: found.cls,
      spentTxid: lc(spentTxid),
      spentVout: vout,
      input: { cx: inCx, cy: inCy, owner: inOwner, leafIndex: found.leafIndex, path: inPath },
      output: { cx: outCx, cy: outCy, owner: dest.owner },
      burnMembership: { next: bm.next, index: bm.index, path: bm.path },
      rangeProof: bytesHex(rangeProof),
      fee: fee.toString(),
      kernel: { R: ptHex(kernel.R), z: hex32(kernel.z) },
    };
    return { op, fee, destLeaf, nullifier: pool.nullifier(found.srcLeaf), burnId: found.burnId, sourceClass: found.cls };
  }

  // The Bitcoin-side half for a REFLECTED note (class 1 or 2): the 161-byte 0x2B burn envelope payload
  //   0x2B ‖ asset ‖ bitcoinPoolRoot ‖ ν ‖ destLeaf ‖ targetChainBinding
  // committing the Ethereum destination to v_burn − fee, plus the destination opening the mint will need. The
  // caller wraps `envelope` in the standard commit/reveal Taproot envelope ("TACIT"‖v1 frame, script-path spend
  // as vin[0]) and spends the burned note in another input of the same reveal tx; that tx must spend no other
  // reflected note. Pass `deriveDestBlinding(nullifier)` (e.g. deriveBridgeMintBlinding from bridge-mint-recovery.js,
  // keyed by the wallet) instead of `dest.blinding` so the minted note is recoverable from the seed.
  function buildBridgeBurnEnvelope({ asset, bitcoinPoolRoot, chainBinding, sourceClass = SOURCE_REFLECTED_BOUND, burned, fee = 0n, dest, deriveDestBlinding = null }) {
    const cls = Number(sourceClass);
    if (cls !== SOURCE_REFLECTED && cls !== SOURCE_REFLECTED_BOUND) throw new Error('bridge-mint: the envelope builder covers reflected notes (class 1 or 2); a burn-deposit has its own path');
    for (const [k, v] of [['asset', asset], ['bitcoinPoolRoot', bitcoinPoolRoot], ['chainBinding', chainBinding], ['burned.owner', burned && burned.owner], ['dest.owner', dest && dest.owner]]) {
      if (!/^0x[0-9a-fA-F]{64}$/.test(String(v))) throw new Error(`bridge-mint: ${k} must be 32 bytes of hex`);
    }
    const vOut = destValueFor({ burnValue: burned.value, fee });
    const { cx, cy } = pool.commitXY(BigInt(burned.value), BigInt(burned.blinding));
    const srcLeaf = sourceLeaf({ sourceClass: cls, asset, cx, cy, owner: burned.owner, chainBinding });
    const nullifier = pool.nullifier(srcLeaf);
    const rDest = BigInt(dest.blinding != null ? dest.blinding : typeof deriveDestBlinding === 'function' ? deriveDestBlinding(nullifier) : 0n);
    if (rDest <= 0n) throw new Error('bridge-mint: dest.blinding or deriveDestBlinding required');
    const d = pool.commitXY(vOut, rDest);
    const destLeaf = pool.leaf(asset, d.cx, d.cy, dest.owner);
    const envelope = '0x2b' + [asset, bitcoinPoolRoot, nullifier, destLeaf, chainBinding].map((h) => String(h).replace(/^0x/, '').toLowerCase()).join('');
    return { envelope, nullifier, destLeaf, fee: BigInt(fee), dest: { value: vOut, blinding: rDest, owner: dest.owner, cx: d.cx, cy: d.cy } };
  }

  // The relay's public reflected-state export (the Bitcoin note tree and the bridge-burn set).
  async function fetchReflectionSnapshot({ network = 'mainnet' } = {}) {
    const f = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!f) throw new Error('bridge-mint: no fetch available');
    const root = String(relayBase || '').replace(/\/$/, '');
    const res = await f(`${root}/reflection/dump?network=${network === 'signet' ? 'signet' : 'mainnet'}`);
    if (!res.ok) throw new Error(`bridge-mint: reflection dump ${res.status}`);
    const j = await res.json();
    const snap = j && j.snapshot;
    if (!snap || !Array.isArray(snap.noteLeaves) || !Array.isArray(snap.burnNodes)) throw new Error('bridge-mint: reflection dump carries no note tree / burn set');
    return { noteLeaves: snap.noteLeaves, burnNodes: snap.burnNodes, height: j.attestedHeight ?? snap.height ?? null };
  }

  // Build the mint and relay it (POST /confidential/submit, type 'bridgemint'), waiting for the settle.
  // `recovery` describes how the minted note stays recoverable from the seed: { ownerPub, secret } seals a memo to
  // the owner's key (secret = the note's nk), or { seedDerived: true } when dest.blinding came from
  // deriveBridgeMintBlinding (bridge-mint-recovery.js), which the recovery scan re-derives on its own. That scan tries
  // round amounts and caller-supplied values, and a destination net of a fee is usually not round, so a fee'd mint
  // should seal a memo.
  async function bridgeMint({ network = 'mainnet', snapshot = null, recovery, ephRand, waitOpts, ...args }) {
    if (!relay) throw new Error('bridge-mint: no relay wired');
    if (!recovery || (!recovery.seedDerived && recovery.ownerPub == null)) {
      throw new Error('bridge-mint: pass recovery { ownerPub, secret } or { seedDerived: true } so the minted note stays recoverable');
    }
    const snap = snapshot || await fetchReflectionSnapshot({ network });
    const built = buildBridgeMintOp({ ...args, snapshot: snap });
    const output = recovery.seedDerived
      ? { seedDerived: true }
      : { ownerPub: recovery.ownerPub, value: String(args.dest.value), blinding: hex32(args.dest.blinding), secret: recovery.secret == null ? 0 : recovery.secret,
          asset: built.op.asset, owner: args.dest.owner, cx: built.op.output.cx, cy: built.op.output.cy };
    const r = await relay.settle({ type: 'bridgemint', op: built.op, leaves: [built.destLeaf], outputs: [output], ephRand: ephRand || freshScalar }, waitOpts);
    return { ...r, ...built };
  }

  return { sourceLeaf, buildBridgeBurnEnvelope, buildBridgeMintOp, fetchReflectionSnapshot, bridgeMint, feeIsQuantized, ladderFee, destValueFor, txidInternal };
}
