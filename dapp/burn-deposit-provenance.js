export function makeBurnDepositProvenance({
  outpointKey,
  sha256,
  verifyCxferConservation,
  commitmentHashCompressed,
  decompress,
  extractTaprootEnvelope,
  parseCmint,
  computeTxid,
  extractInputs,
  bip340Verify,
  verifyRange,
  leaf,
  btcNoteLeaf,
  btcNoteLeafBound,
  merkleRootFrom,
  commitmentHash,
} = {}) {
  const stripHex = (h) => (h.startsWith('0x') ? h.slice(2) : h);
  const hexToBytes = (h) => {
    h = stripHex(h);
    const a = new Uint8Array(h.length / 2);
    for (let i = 0; i < a.length; i++) a[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
    return a;
  };
  const bytesToHex = (b) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  const concatBytes = (...arrs) => {
    const total = arrs.reduce((n, a) => n + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrs) { out.set(a, off); off += a.length; }
    return out;
  };
  const u32le = (n) => {
    const a = new Uint8Array(4);
    a[0] = n & 0xff; a[1] = (n >>> 8) & 0xff; a[2] = (n >>> 16) & 0xff; a[3] = (n >>> 24) & 0xff;
    return a;
  };
  const CMINT_DOMAIN = new TextEncoder().encode('tacit-mint-v1');

  function verifyMerklePath(txidHex, siblingsHex, index) {
    let acc = hexToBytes(txidHex);
    let idx = index >>> 0;
    for (const sibHex of siblingsHex) {
      const sib = hexToBytes(sibHex);
      const combined = new Uint8Array(64);
      if ((idx & 1) === 0) {
        combined.set(acc, 0);
        combined.set(sib, 32);
      } else {
        combined.set(sib, 0);
        combined.set(acc, 32);
      }
      acc = sha256(sha256(combined));
      idx = idx >>> 1;
    }
    return bytesToHex(acc);
  }

  function verifyProvenanceDagLeaves(validLeaves, burnedOutpoint, burnedCommitmentHash, cxfers) {
    if (!cxfers.length) return false;
    const produced = new Map();
    for (const cx of cxfers) {
      if (!cx.outputs.length) return false;
      for (const [vout, ch] of cx.outputs) {
        const op = outpointKey(cx.txid, vout);
        if (produced.has(op)) return false;
        produced.set(op, ch);
      }
    }
    const consumed = new Set();
    for (const cx of cxfers) {
      if (!cx.inputs.length) return false;
      for (const [prevTxid, prevVout, inCh] of cx.inputs) {
        const op = outpointKey(prevTxid, prevVout);
        if (consumed.has(op)) return false;
        consumed.add(op);
        const linked = produced.has(op) && produced.get(op) === inCh;
        const isLeaf = validLeaves.some(([lo, lch]) => op === lo && inCh === lch);
        if (!linked && !isLeaf) return false;
      }
    }
    const producedBurned = produced.get(burnedOutpoint) === burnedCommitmentHash;
    const consumedBurned = consumed.has(burnedOutpoint);
    return producedBurned && !consumedBurned;
  }

  function verifyProvenanceDag(c0Outpoint, c0CommitmentHash, burnedOutpoint, burnedCommitmentHash, cxfers) {
    return verifyProvenanceDagLeaves(
      [[c0Outpoint, c0CommitmentHash]], burnedOutpoint, burnedCommitmentHash, cxfers,
    );
  }

  function verifyProvenance(asset, c0Outpoint, c0CommitmentHash, burnedOutpoint, burnedCommitmentHash, cxfers) {
    return verifyProvenanceLeaves(
      asset, [[c0Outpoint, c0CommitmentHash]], burnedOutpoint, burnedCommitmentHash, cxfers,
    );
  }

  function verifyProvenanceLeaves(asset, validLeaves, burnedOutpoint, burnedCommitmentHash, cxfers) {
    if (!cxfers.length) return false;
    const verified = [];
    for (const cx of cxfers) {
      if (cx.inputCommitments.length !== cx.inputOutpoints.length) return false;
      if (cx.outputCommitments.length !== cx.outputVouts.length) return false;
      if (stripHex(verifyMerklePath(cx.txid, cx.merkleSiblings, cx.merkleIndex)) !== stripHex(cx.confirmedBlockRoot)) return false;
      const inputPoints = [];
      for (const c of cx.inputCommitments) {
        const p = decompress(c);
        if (!p) return false;
        inputPoints.push(p);
      }
      if (!verifyCxferConservation(asset, cx.inputOutpoints, inputPoints, cx.outputCommitments, cx.rangeProof, cx.kernelSig, cx.burnedAmount || 0)) {
        return false;
      }
      const inputs = cx.inputOutpoints.map(([prevTxid, prevVout], i) => [
        prevTxid,
        prevVout,
        commitmentHashCompressed(cx.inputCommitments[i]),
      ]);
      const outputs = cx.outputCommitments.map((c, i) => [cx.outputVouts[i], commitmentHashCompressed(c)]);
      verified.push({ txid: cx.txid, inputs, outputs });
    }
    return verifyProvenanceDagLeaves(validLeaves, burnedOutpoint, burnedCommitmentHash, verified);
  }

  function verifyCmintAuthorized(asset, mintAuthority, revealTxHex, commitTxHex) {
    if (hexToBytes(mintAuthority).every((b) => b === 0)) return null;
    const env = extractTaprootEnvelope(revealTxHex);
    if (!env) return null;
    const parsed = parseCmint(env);
    if (!parsed) return null;
    const { asset: mintAsset, commitment, encryptedAmount, rangeProof, issuerSig } = parsed;
    if (stripHex(mintAsset) !== stripHex(asset)) return null;
    const commitTxid = computeTxid(commitTxHex);
    const revInputs = extractInputs(revealTxHex);
    if (!revInputs || !revInputs.length) return null;
    if (stripHex(revInputs[0].prevTxid) !== stripHex(commitTxid)) return null;
    const comInputs = extractInputs(commitTxHex);
    if (!comInputs || !comInputs.length) return null;
    const mintMsg = sha256(concatBytes(
      CMINT_DOMAIN,
      hexToBytes(asset),
      hexToBytes(comInputs[0].prevTxid),
      u32le(comInputs[0].prevVout >>> 0),
      hexToBytes(commitment),
      hexToBytes(encryptedAmount),
    ));
    if (!bip340Verify(issuerSig, mintMsg, mintAuthority)) return null;
    const c = decompress(commitment);
    if (!c) return null;
    if (!verifyRange([c], rangeProof)) return null;
    return [outpointKey(computeTxid(revealTxHex), 0), commitmentHashCompressed(commitment)];
  }

  function verifyPoolMembershipLeaf(asset, poolRoot, outpoint, cx, cy, owner, noteClass, chainBinding, leafIndex, path) {
    let treeLeaf;
    if (noteClass === 0) treeLeaf = leaf(asset, cx, cy, owner);
    else if (noteClass === 1) treeLeaf = btcNoteLeaf(asset, cx, cy, owner);
    else if (noteClass === 2) treeLeaf = btcNoteLeafBound(asset, cx, cy, owner, chainBinding);
    else return null;
    const root = merkleRootFrom(treeLeaf, leafIndex, path);
    if (stripHex(root).toLowerCase() !== stripHex(poolRoot).toLowerCase()) return null;
    return [outpoint, commitmentHash(cx, cy)];
  }

  // SEGMENTED provenance (STUCK-TAC option D): the JS mirror of cxfer-core's
  // `verify_provenance_segmented`. A lineage too long for one 256-CXFER blob — or one that
  // passes through a shielded-pool exit (a fact the etch-to-burn walk cannot express) — splits
  // into segments at ANCHOR points the reflection itself has proven: the etch supply note `C_0`,
  // a verified pool-membership leaf, or a DEPOSIT-LEAF anchor (an (outpoint, commitmentHash) pair
  // proven against the fold's own depositLeavesRoot accumulator, which the reflection fills with
  // every note it onboards). Same invariants as the single-DAG check, applied per segment plus
  // across the shared produced/consumed index: one outpoint, one producer; every input resolves
  // inside its segment or at a proven anchor; the burned note is PRODUCED (never merely anchored)
  // and never consumed. Mirrors the Rust test suite (segmented_* in burn_deposit.rs).
  function verifyProvenanceSegmented(anchors, burnedOutpoint, burnedCommitmentHash, segments) {
    const norm = (x) => stripHex(x).toLowerCase();
    const produced = new Map();
    const consumed = new Set();
    const reachable = anchors.map(([o, ch]) => [norm(o), norm(ch)]);
    for (const segment of segments) {
      if (!segment.length) return false;
      for (const cx of segment) {
        if (!cx.outputs.length || !cx.inputs.length) return false;
        for (const [vout, ch] of cx.outputs) {
          const op = norm(outpointKey(cx.txid, vout));
          if (produced.has(op)) return false;
          produced.set(op, norm(ch));
        }
        for (const [prevTxid, prevVout] of cx.inputs) {
          const op = norm(outpointKey(prevTxid, prevVout));
          if (consumed.has(op)) return false;
          consumed.add(op);
        }
      }
      const accepted = new Array(segment.length).fill(false);
      let progress = true;
      while (progress) {
        progress = false;
        segment.forEach((cx, i) => {
          if (accepted[i]) return;
          const allInputsReachable = cx.inputs.every(([prevTxid, prevVout, inCh]) => {
            const op = norm(outpointKey(prevTxid, prevVout));
            return reachable.some(([o, ch]) => o === op && ch === norm(inCh));
          });
          if (allInputsReachable) {
            accepted[i] = true;
            progress = true;
            for (const [vout, ch] of cx.outputs) {
              reachable.push([norm(outpointKey(cx.txid, vout)), norm(ch)]);
            }
          }
        });
      }
      if (accepted.some((a) => !a)) return false;
    }
    if (consumed.has(norm(burnedOutpoint))) return false;
    const producedCh = produced.get(norm(burnedOutpoint));
    return producedCh !== undefined && producedCh === norm(burnedCommitmentHash);
  }

  return {
    verifyMerklePath,
    verifyProvenanceDag,
    verifyProvenanceDagLeaves,
    verifyProvenanceSegmented,
    verifyProvenance,
    verifyProvenanceLeaves,
    verifyCmintAuthorized,
    verifyPoolMembershipLeaf,
  };
}
