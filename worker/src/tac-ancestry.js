// Full chain-of-custody verification for a Bitcoin-metaprotocol asset UTXO — walks its ancestry back to a
// CETCH (or an authorized T_MINT on top of one), checking the kernel signature (conservation) and the
// rangeproof (non-negativity) at every hop. This is the same pair of checks the dapp's own holdings
// scanner runs (dapp/tacit.js validateOutpoint) before it will ever credit a balance from a UTXO.
//
// Why this exists as its own module: commitmentForUtxo (worker/src/index.js) decodes only the ONE hop
// asked for and returns whatever asset_id/commitment bytes that envelope happens to declare — it was
// built for cheap display lookups (an opening/listing's commitment), where a wrong answer just shows a
// wrong number. It is not a proof of custody: nothing about it stops any (asset_id, commitment) pair
// from being self-declared in an otherwise-ordinary Bitcoin transaction. Anywhere a UTXO's asset balance
// is used to GRANT something (governance weight, ceremony eligibility, a role) needs the real check here
// instead, mirroring the dapp's own bar for crediting a balance.
//
// Scope: covers every opcode whose conservation is provable from Bitcoin data alone — T_CETCH, T_MINT,
// T_CXFER(_BPP), T_BURN, T_AXFER(_BPP), T_AXFER_VAR(_BPP), T_CXFER_BOUND. An ancestor under any other
// opcode (a Bitcoin-pool exit note, a cross-out mint whose validity rests on the reflection guest's own
// Ethereum-state proof rather than on anything checkable here, …) fails closed — verification stops and
// the UTXO is treated as unproven, not credited. That is a coverage gap for a holder whose TAC arrived by
// one of those rarer paths, not a soundness gap: failing closed can only ever under-grant, never over-grant.
//
// All deps are injected (same convention as dapp/confidential-stealth.js etc.) so this module shares the
// caller's own secp/hash instances and reuses index.js's already-verified crypto primitives rather than
// re-deriving them a second time. `apiJson`/`env` are threaded through per-call (like every other worker
// helper), not captured at factory time, since `env` is per-request.
export function makeTacAncestry({
  apiJson, secp, sha256, hexToBytes, bytesToHex, concatBytes,
  decodeEnvelopeScript, bpRangeAggVerify, bppRangeVerify, verifySchnorr, kernelMsg, H,
}) {
  const SECP_N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const ZERO = secp.ProjectivePoint.ZERO;
  const reverseBytes = (b) => { const r = new Uint8Array(b); r.reverse(); return r; };
  const u32le = (n) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n >>> 0, true); return b; };
  const toPoint = (b33) => secp.ProjectivePoint.fromHex(bytesToHex(b33));
  const safeMult = (P, s) => { const x = ((BigInt(s) % SECP_N) + SECP_N) % SECP_N; return x === 0n ? ZERO : P.multiply(x); };

  const T_CETCH = 0x21, T_CXFER_BPP = 0x22, T_CXFER = 0x23, T_MINT = 0x24, T_BURN = 0x25, T_AXFER = 0x26, T_AXFER_BPP = 0x3C;
  const T_AXFER_VAR = 0x37, T_AXFER_VAR_BPP = 0x3D, T_CXFER_BOUND = 0x39;

  // ---- local decoders (raw-byte fields — kernel_sig/rangeproof/issuer_sig included, unlike index.js's
  // display-only decoders, which discard exactly those fields since they never needed to verify them) ----
  function decCetch(payload) {
    if (!payload || payload.length < 1 + 1 + 1 + 1 + 33 + 8 + 2 + 32 + 2 || payload[0] !== T_CETCH) return null;
    let p = 1;
    const tlen = payload[p]; p += 1;
    if (tlen < 1 || tlen > 16 || p + tlen > payload.length) return null;
    p += tlen;
    const decimals = payload[p]; p += 1;
    if (decimals > 8 || p + 33 + 8 + 2 > payload.length) return null;
    const commitment = payload.slice(p, p + 33); p += 33;
    p += 8; // amount_ct
    const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (p + rpLen + 32 + 2 > payload.length) return null;
    const rangeproof = payload.slice(p, p + rpLen); p += rpLen;
    const mintAuthority = payload.slice(p, p + 32); p += 32;
    const imgLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (imgLen > 256 || p + imgLen !== payload.length) return null;
    let mintable = false;
    for (let i = 0; i < 32; i++) if (mintAuthority[i] !== 0) { mintable = true; break; }
    return { commitment, rangeproof, mintAuthority, mintable };
  }
  function decMint(payload) {
    if (!payload || payload.length < 1 + 32 + 32 + 33 + 8 + 2 + 64 || payload[0] !== T_MINT) return null;
    let p = 1;
    const assetId = payload.slice(p, p + 32); p += 32;
    const etchTxid = payload.slice(p, p + 32); p += 32;
    const commitment = payload.slice(p, p + 33); p += 33;
    const encryptedAmount = payload.slice(p, p + 8); p += 8;
    const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (p + rpLen + 64 > payload.length) return null;
    const rangeproof = payload.slice(p, p + rpLen); p += rpLen;
    const issuerSig = payload.slice(p, p + 64); p += 64;
    if (p !== payload.length) return null;
    return { assetId, etchTxid, commitment, encryptedAmount, rangeproof, issuerSig };
  }
  function decOutputs(payload, p, n) {
    const outputs = [];
    for (let i = 0; i < n; i++) {
      if (p + 33 + 8 > payload.length) return null;
      const commitment = payload.slice(p, p + 33); p += 33;
      p += 8; // amount_ct
      outputs.push({ commitment });
    }
    return { outputs, p };
  }
  function decCxferLike(payload, opcode) {
    if (!payload || payload.length < 1 + 32 + 64 + 1 || payload[0] !== opcode) return null;
    let p = 1;
    const assetId = payload.slice(p, p + 32); p += 32;
    const kernelSig = payload.slice(p, p + 64); p += 64;
    const n = payload[p]; p += 1;
    if (![1, 2, 4, 8].includes(n)) return null;
    const dec = decOutputs(payload, p, n);
    if (!dec) return null;
    p = dec.p;
    if (p + 2 > payload.length) return null;
    const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (p + rpLen !== payload.length) return null;
    return { assetId, kernelSig, outputs: dec.outputs, rangeproof: payload.slice(p, p + rpLen) };
  }
  function decBurn(payload) {
    if (!payload || payload.length < 1 + 32 + 8 + 64 + 1 || payload[0] !== T_BURN) return null;
    let p = 1;
    const assetId = payload.slice(p, p + 32); p += 32;
    const burnedLE = payload.slice(p, p + 8); p += 8;
    const view = new DataView(burnedLE.buffer, burnedLE.byteOffset, 8);
    const burnedAmount = (BigInt(view.getUint32(4, true)) << 32n) | BigInt(view.getUint32(0, true));
    const kernelSig = payload.slice(p, p + 64); p += 64;
    const n = payload[p]; p += 1;
    if (![0, 1, 2, 4, 8].includes(n)) return null;
    const dec = decOutputs(payload, p, n);
    if (!dec) return null;
    p = dec.p;
    let rangeproof = new Uint8Array(0);
    if (n > 0) {
      if (p + 2 > payload.length) return null;
      const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
      if (p + rpLen !== payload.length) return null;
      rangeproof = payload.slice(p, p + rpLen);
    } else if (p !== payload.length) return null;
    return { assetId, burnedAmount, kernelSig, outputs: dec.outputs, rangeproof };
  }
  function decAxferLike(payload, opcode) {
    if (!payload || payload.length < 1 + 32 + 1 + 64 + 1 || payload[0] !== opcode) return null;
    let p = 1;
    const assetId = payload.slice(p, p + 32); p += 32;
    const assetInputCount = payload[p]; p += 1;
    if (assetInputCount < 1) return null;
    const kernelSig = payload.slice(p, p + 64); p += 64;
    const n = payload[p]; p += 1;
    if (![1, 2, 4, 8].includes(n)) return null;
    const dec = decOutputs(payload, p, n);
    if (!dec) return null;
    p = dec.p;
    if (p + 2 > payload.length) return null;
    const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (p + rpLen !== payload.length) return null;
    return { assetId, assetInputCount, kernelSig, outputs: dec.outputs, rangeproof: payload.slice(p, p + rpLen) };
  }
  // T_AXFER_VAR(_BPP): the decoder's own SPEC-mandated tightenings (asset_input_count exactly 1, N exactly
  // 2) leave asset_input_count out of the return value on purpose — a caller that needs it would be
  // misusing this opcode's single-input, two-output shape.
  function decAxferVarLike(payload, opcode) {
    if (!payload || payload.length < 1 + 32 + 1 + 64 + 1 || payload[0] !== opcode) return null;
    let p = 1;
    const assetId = payload.slice(p, p + 32); p += 32;
    const assetInputCount = payload[p]; p += 1;
    if (assetInputCount !== 1) return null;
    const kernelSig = payload.slice(p, p + 64); p += 64;
    const n = payload[p]; p += 1;
    if (n !== 2) return null;
    const dec = decOutputs(payload, p, n);
    if (!dec) return null;
    p = dec.p;
    if (p + 2 > payload.length) return null;
    const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (p + rpLen !== payload.length) return null;
    return { assetId, kernelSig, outputs: dec.outputs, rangeproof: payload.slice(p, p + rpLen) };
  }
  // T_AXFER_VAR's on-chain layout is interleaved, not contiguous: vout 0 = recipient (outputs[0]), vout 1 =
  // the maker's plain BTC payment (not tacit), vout 2 = maker change (outputs[1]), vout 3+ = OP_RETURN
  // recovery / taker BTC change (not tacit). Returns the payload output index for a tacit vout, or null.
  function axferVarOutputIndexForVout(vout) {
    if (vout === 0) return 0;
    if (vout === 2) return 1;
    return null;
  }
  // T_CXFER_BOUND (0x39): T_CXFER's body behind a 32-byte target_chain_binding header — same asset_id,
  // kernel_sig and output layout, just offset by the extra field. The binding matters to the reflection
  // guest, not to Bitcoin-side conservation, so it plays no part in the kernel transcript below.
  function decCxferBound(payload) {
    if (!payload || payload.length < 1 + 32 + 32 + 64 + 1 || payload[0] !== T_CXFER_BOUND) return null;
    let p = 1;
    p += 32; // target_chain_binding
    const assetId = payload.slice(p, p + 32); p += 32;
    const kernelSig = payload.slice(p, p + 64); p += 64;
    const n = payload[p]; p += 1;
    if (![1, 2, 4, 8].includes(n)) return null;
    const dec = decOutputs(payload, p, n);
    if (!dec) return null;
    p = dec.p;
    if (p + 2 > payload.length) return null;
    const rpLen = payload[p] | (payload[p + 1] << 8); p += 2;
    if (p + rpLen !== payload.length) return null;
    return { assetId, kernelSig, outputs: dec.outputs, rangeproof: payload.slice(p, p + rpLen) };
  }

  function assetIdForRaw(etchTxidHex, etchVout) {
    return sha256(concatBytes(reverseBytes(hexToBytes(etchTxidHex)), u32le(etchVout)));
  }
  const eqBytes = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

  const MINT_MSG_DOMAIN = new TextEncoder().encode('tacit-mint-v1');
  function computeMintMsg(assetId, commitAnchor, commitment, encryptedAmount) {
    return sha256(concatBytes(MINT_MSG_DOMAIN, assetId, commitAnchor, commitment, encryptedAmount));
  }

  // Bounds worst-case work per attestation. Real TAC lineages can run into the hundreds of hops (long chains
  // of small transfers/consolidations over months of circulation are common) — 64 was too tight and rejected
  // genuine holdings as "too deep to verify"; 512 comfortably covers observed real chains while still capping
  // a single attestation's cost (each hop is a small, bounded number of chain reads, not exponential).
  const DEFAULT_MAX_DEPTH = 512;

  // Record a verdict for every vout of a just-checked CXFER-family tx at once (its kernel sig covers the
  // whole tx), so a sibling vout cited elsewhere in the same attestation hits the memo instead of
  // re-verifying. On failure every vout shares the one `result` object (the failure applies tx-wide). On
  // success `result.commitment` is PER-VOUT — output j's real commitment, never output `vout`'s borrowed
  // into every other vout's cache entry, which would silently swap in the wrong commitment for any j != vout
  // and break that vout's own callers (a caller's E' computation, comparing kernel signatures, would use a
  // materially different point than the one actually on-chain at that vout).
  function memoAll(memo, txidHex, n, result, perVoutCommitment = null) {
    for (let j = 0; j < Math.max(n, 1); j++) {
      memo.set(`${txidHex}:${j}`, perVoutCommitment ? { ...result, commitment: perVoutCommitment(j) } : result);
    }
    return result;
  }

  // `env` carries the runtime bindings (KV etc.) — passed through to apiJson exactly like every other
  // call site in index.js, never captured at factory time.
  async function verifyTacAncestry(env, txidHex, vout, network, opts = {}) {
    const memo = opts.memo || new Map();
    return _walk(env, txidHex, vout, network, memo, 0, opts.maxDepth ?? DEFAULT_MAX_DEPTH);
  }

  // ---- persistent cache (env.REGISTRY_KV) ----
  // A verified verdict for a specific (txid, vout) is an eternal fact about immutable Bitcoin history — once
  // computed, it never needs recomputing, unlike xferseen's rolling recent-activity index (deliberately
  // TTL'd, a different kind of data with a different lifetime). No expirationTtl here, same as holderseen.
  // Never load-bearing: any read/write failure here just falls back to doing the real walk, exactly as if
  // no KV were bound at all — caching is a pure optimization, and must stay one.
  const _persistKey = (network, txidHex, vout) => `tacanc:${network}:${txidHex}:${vout}`;
  async function _loadCached(env, network, txidHex, vout) {
    if (!env?.REGISTRY_KV) return null;
    try {
      const v = await env.REGISTRY_KV.get(_persistKey(network, txidHex, vout), 'json');
      if (!v) return null;
      return v.commitment ? { ...v, commitment: hexToBytes(v.commitment) } : v;
    } catch { return null; }
  }
  // Only a verdict that can never change is worth keeping forever: a real ok:true/false verifies against
  // immutable bytes on chain, but "fetch failed" is a transient outage (must be retried, not entombed as a
  // permanent no) and "ancestry deeper than N hops" is a fact about THIS CALL's maxDepth, not about the
  // transaction — a future caller with a higher maxDepth deserves a fresh answer, not a stale cutoff.
  function _isPermanent(result) {
    if (result.ok) return true;
    const reason = result.reason || '';
    return !reason.startsWith('fetch ') && !reason.startsWith('ancestry deeper than');
  }
  async function _saveIfPermanent(env, network, txidHex, vout, result) {
    if (!env?.REGISTRY_KV || !_isPermanent(result)) return;
    try {
      const stored = result.commitment ? { ...result, commitment: bytesToHex(result.commitment) } : result;
      await env.REGISTRY_KV.put(_persistKey(network, txidHex, vout), JSON.stringify(stored));
    } catch { /* best-effort — a failed write just means the next caller re-verifies */ }
  }

  async function _walk(env, txidHex, vout, network, memo, depth, maxDepth) {
    const key = `${txidHex}:${vout}`;
    if (memo.has(key)) return memo.get(key);
    if (depth > maxDepth) return { ok: false, reason: `ancestry deeper than ${maxDepth} hops — not verified` };

    const cached = await _loadCached(env, network, txidHex, vout);
    if (cached) { memo.set(key, cached); return cached; }

    const result = await _walkCompute(env, txidHex, vout, network, memo, depth, maxDepth);
    await _saveIfPermanent(env, network, txidHex, vout, result);
    return result;
  }

  async function _walkCompute(env, txidHex, vout, network, memo, depth, maxDepth) {
    const key = `${txidHex}:${vout}`;

    let tx;
    try { tx = await apiJson(env, `/tx/${txidHex}`, {}, network); }
    catch (e) { return { ok: false, reason: `fetch ${txidHex} failed: ${e.message || 'unknown'}` }; }
    if (!tx?.vin?.[0]?.witness || tx.vin[0].witness.length < 3) {
      const r = { ok: false, reason: `${txidHex} has no taproot script-path witness` }; memo.set(key, r); return r;
    }
    let envelope;
    try { envelope = decodeEnvelopeScript(hexToBytes(tx.vin[0].witness[1])); } catch { envelope = null; }
    if (!envelope) { const r = { ok: false, reason: `${txidHex} is not a tacit envelope` }; memo.set(key, r); return r; }

    if (envelope.opcode === T_CETCH) {
      if (vout !== 0) { const r = { ok: false, reason: 'CETCH supply lives at vout 0 only', notTacit: true }; memo.set(key, r); return r; }
      const dec = decCetch(envelope.payload);
      if (!dec) { const r = { ok: false, reason: 'invalid CETCH payload' }; memo.set(key, r); return r; }
      let Cpt;
      try { Cpt = toPoint(dec.commitment); } catch { const r = { ok: false, reason: 'bad CETCH commitment' }; memo.set(key, r); return r; }
      if (!bpRangeAggVerify([Cpt], dec.rangeproof)) {
        const r = { ok: false, reason: 'CETCH rangeproof failed' }; memo.set(key, r); return r;
      }
      // mintAuthority/mintable ride along so a T_MINT child can read them straight off this result instead of
      // re-fetching and re-decoding the same etch tx a second time (see below).
      const r = { ok: true, assetIdHex: bytesToHex(assetIdForRaw(txidHex, 0)), commitment: dec.commitment, mintAuthority: dec.mintAuthority, mintable: dec.mintable };
      memo.set(key, r);
      return r;
    }

    if (envelope.opcode === T_MINT) {
      if (vout !== 0) { const r = { ok: false, reason: 'T_MINT supply lives at vout 0 only', notTacit: true }; memo.set(key, r); return r; }
      const dec = decMint(envelope.payload);
      if (!dec) { const r = { ok: false, reason: 'invalid T_MINT payload' }; memo.set(key, r); return r; }
      const etchTxidHex = bytesToHex(dec.etchTxid);
      if (!eqBytes(assetIdForRaw(etchTxidHex, 0), dec.assetId)) {
        const r = { ok: false, reason: 'T_MINT asset_id does not match its etch ancestor' }; memo.set(key, r); return r;
      }
      // The CETCH ancestor must itself verify (real rangeproof, real root) before its mint_authority is trusted.
      // Its own successful result already carries mintAuthority/mintable, so there's no need to fetch and
      // re-decode the same etch tx a second time just to read those two fields.
      const etchR = await _walk(env, etchTxidHex, 0, network, memo, depth + 1, maxDepth);
      if (!etchR.ok) { const r = { ok: false, reason: `T_MINT etch ancestor: ${etchR.reason}` }; memo.set(key, r); return r; }
      if (!etchR.mintable) {
        const r = { ok: false, reason: 'T_MINT etch ancestor is not mintable' }; memo.set(key, r); return r;
      }
      // Anchor the issuer signature to the mint's own commit tx funding outpoint (see computeMintMsg above).
      let mintCommitTx;
      try { mintCommitTx = await apiJson(env, `/tx/${tx.vin[0].txid}`, {}, network); }
      catch (e) { const r = { ok: false, reason: `fetch mint commit tx failed: ${e.message || 'unknown'}` }; memo.set(key, r); return r; }
      const ci = mintCommitTx?.vin?.[0];
      if (!ci) { const r = { ok: false, reason: 'mint commit tx has no funding input' }; memo.set(key, r); return r; }
      const mintAnchor = concatBytes(reverseBytes(hexToBytes(ci.txid)), u32le(ci.vout));
      const mintMsg = computeMintMsg(dec.assetId, mintAnchor, dec.commitment, dec.encryptedAmount);
      if (!verifySchnorr(dec.issuerSig, mintMsg, etchR.mintAuthority)) {
        const r = { ok: false, reason: 'T_MINT issuer signature invalid' }; memo.set(key, r); return r;
      }
      let Cpt;
      try { Cpt = toPoint(dec.commitment); } catch { const r = { ok: false, reason: 'bad T_MINT commitment' }; memo.set(key, r); return r; }
      if (!bpRangeAggVerify([Cpt], dec.rangeproof)) {
        const r = { ok: false, reason: 'T_MINT rangeproof failed' }; memo.set(key, r); return r;
      }
      const r = { ok: true, assetIdHex: bytesToHex(dec.assetId), commitment: dec.commitment };
      memo.set(key, r);
      return r;
    }

    if (envelope.opcode === T_CXFER || envelope.opcode === T_CXFER_BPP || envelope.opcode === T_BURN
      || envelope.opcode === T_AXFER || envelope.opcode === T_AXFER_BPP) {
      const isBurn = envelope.opcode === T_BURN;
      // The dapp gates _BPP envelopes behind a client-side opt-out toggle (bppEnabled()) so a cautious user can
      // choose not to trust Bulletproofs+-sourced balances before it's battle-tested. That's a display
      // preference, not a protocol rule — bppRangeVerify either accepts a genuinely valid proof or it doesn't,
      // so a custody check has no reason to mirror the opt-out here.
      const isBpp = envelope.opcode === T_CXFER_BPP || envelope.opcode === T_AXFER_BPP;
      const isAxfer = envelope.opcode === T_AXFER || envelope.opcode === T_AXFER_BPP;
      const dec = isBurn ? decBurn(envelope.payload)
        : isAxfer ? decAxferLike(envelope.payload, envelope.opcode)
        : decCxferLike(envelope.payload, envelope.opcode);
      if (!dec) { const r = { ok: false, reason: `invalid opcode 0x${envelope.opcode.toString(16)} payload` }; memo.set(key, r); return r; }
      const N = dec.outputs.length;
      if (vout >= N) { const r = { ok: false, reason: `vout ${vout} is not a tacit output of this tx`, notTacit: true }; memo.set(key, r); return r; }
      const assetInputEnd = isAxfer ? 1 + dec.assetInputCount : tx.vin.length;
      if (isAxfer && (dec.assetInputCount < 1 || dec.assetInputCount > 255)) {
        return memoAll(memo, txidHex, N, { ok: false, reason: 'asset_input_count out of range' });
      }
      if (tx.vin.length < Math.max(2, assetInputEnd)) {
        return memoAll(memo, txidHex, N, { ok: false, reason: 'too few inputs for this opcode' });
      }
      if (assetInputEnd - 1 > 255) {
        return memoAll(memo, txidHex, N, { ok: false, reason: 'asset input count exceeds kernel_msg wire limit' });
      }

      // Every asset input must itself verify — this is the actual chain-of-custody check; everything else in
      // this branch is the same conservation/range math commitmentForUtxo's callers were skipping entirely.
      const ourAssetIdHex = bytesToHex(dec.assetId);
      const inputCommitments = [];
      for (let i = 1; i < assetInputEnd; i++) {
        const inp = tx.vin[i];
        const r = await _walk(env, inp.txid, inp.vout, network, memo, depth + 1, maxDepth);
        if (!r.ok) return memoAll(memo, txidHex, N, { ok: false, reason: `input ${inp.txid}:${inp.vout}: ${r.reason}` });
        if (r.assetIdHex !== ourAssetIdHex) {
          return memoAll(memo, txidHex, N, { ok: false, reason: `input ${inp.txid}:${inp.vout} is a different asset` });
        }
        inputCommitments.push(r.commitment);
      }

      if (N > 0) {
        let Cpts;
        try { Cpts = dec.outputs.map((o) => toPoint(o.commitment)); }
        catch { return memoAll(memo, txidHex, N, { ok: false, reason: 'bad output commitment' }); }
        const rpOk = isBpp ? bppRangeVerify(Cpts, dec.rangeproof) : bpRangeAggVerify(Cpts, dec.rangeproof);
        if (!rpOk) return memoAll(memo, txidHex, N, { ok: false, reason: 'output rangeproof failed' });
      }

      let EPrime = ZERO;
      try {
        for (const o of dec.outputs) EPrime = EPrime.add(toPoint(o.commitment));
        if (isBurn && dec.burnedAmount > 0n) EPrime = EPrime.add(safeMult(H, dec.burnedAmount));
        for (const c of inputCommitments) EPrime = EPrime.add(toPoint(c).negate());
      } catch { return memoAll(memo, txidHex, N, { ok: false, reason: 'commitment arithmetic failed' }); }
      if (EPrime.equals(ZERO)) return memoAll(memo, txidHex, N, { ok: false, reason: 'zero kernel excess' });

      const exBytes = EPrime.toRawBytes(true).slice(1);
      const inputOutpoints = tx.vin.slice(1, assetInputEnd).map((v) => ({ txid: v.txid, vout: v.vout }));
      const outputCommitments = dec.outputs.map((o) => o.commitment);
      const msg = kernelMsg(dec.assetId, inputOutpoints, outputCommitments, isBurn ? dec.burnedAmount : 0n);
      if (!verifySchnorr(dec.kernelSig, msg, exBytes)) {
        return memoAll(memo, txidHex, N, { ok: false, reason: 'kernel signature invalid' });
      }
      memoAll(memo, txidHex, N, { ok: true, assetIdHex: ourAssetIdHex }, (j) => dec.outputs[j].commitment);
      return memo.get(key);
    }

    if (envelope.opcode === T_CXFER_BOUND) {
      const dec = decCxferBound(envelope.payload);
      if (!dec) { const r = { ok: false, reason: 'invalid T_CXFER_BOUND payload' }; memo.set(key, r); return r; }
      const N = dec.outputs.length;
      if (vout >= N) { const r = { ok: false, reason: `vout ${vout} is not a tacit output of this tx`, notTacit: true }; memo.set(key, r); return r; }
      if (tx.vin.length < 2 || tx.vin.length - 1 > 255) {
        return memoAll(memo, txidHex, N, { ok: false, reason: 'too few or too many inputs for T_CXFER_BOUND' });
      }
      const ourAssetIdHex = bytesToHex(dec.assetId);
      const inputCommitments = [];
      for (let i = 1; i < tx.vin.length; i++) {
        const inp = tx.vin[i];
        const r = await _walk(env, inp.txid, inp.vout, network, memo, depth + 1, maxDepth);
        if (!r.ok) return memoAll(memo, txidHex, N, { ok: false, reason: `input ${inp.txid}:${inp.vout}: ${r.reason}` });
        if (r.assetIdHex !== ourAssetIdHex) {
          return memoAll(memo, txidHex, N, { ok: false, reason: `input ${inp.txid}:${inp.vout} is a different asset` });
        }
        inputCommitments.push(r.commitment);
      }
      let Cpts;
      try { Cpts = dec.outputs.map((o) => toPoint(o.commitment)); }
      catch { return memoAll(memo, txidHex, N, { ok: false, reason: 'bad output commitment' }); }
      // Unlike every other opcode here, the proof scheme isn't opcode-selected — both classic and BP+
      // proofs ride the same 0x39 byte, distinguished only by the proof's own length (mirrors the dapp's
      // validateOutpoint exactly, cxfer-core's verify_range dispatch).
      const bppLen = 99 + 96 + Math.log2(64 * N) * 66;
      const rpOk = dec.rangeproof.length === bppLen ? bppRangeVerify(Cpts, dec.rangeproof) : bpRangeAggVerify(Cpts, dec.rangeproof);
      if (!rpOk) return memoAll(memo, txidHex, N, { ok: false, reason: 'output rangeproof failed' });
      let EPrime = ZERO;
      try {
        for (const o of dec.outputs) EPrime = EPrime.add(toPoint(o.commitment));
        for (const c of inputCommitments) EPrime = EPrime.add(toPoint(c).negate());
      } catch { return memoAll(memo, txidHex, N, { ok: false, reason: 'commitment arithmetic failed' }); }
      if (EPrime.equals(ZERO)) return memoAll(memo, txidHex, N, { ok: false, reason: 'zero kernel excess' });
      const exBytes = EPrime.toRawBytes(true).slice(1);
      const inputOutpoints = tx.vin.slice(1).map((v) => ({ txid: v.txid, vout: v.vout }));
      const outputCommitments = dec.outputs.map((o) => o.commitment);
      // Same kernel domain/shape as plain CXFER (no burn term, no binding-aware transcript) — the
      // target_chain_binding header byte plays no part in conservation.
      const msg = kernelMsg(dec.assetId, inputOutpoints, outputCommitments, 0n);
      if (!verifySchnorr(dec.kernelSig, msg, exBytes)) {
        return memoAll(memo, txidHex, N, { ok: false, reason: 'kernel signature invalid' });
      }
      memoAll(memo, txidHex, N, { ok: true, assetIdHex: ourAssetIdHex }, (j) => dec.outputs[j].commitment);
      return memo.get(key);
    }

    if (envelope.opcode === T_AXFER_VAR || envelope.opcode === T_AXFER_VAR_BPP) {
      const isBpp = envelope.opcode === T_AXFER_VAR_BPP;
      const dec = decAxferVarLike(envelope.payload, envelope.opcode);
      if (!dec) { const r = { ok: false, reason: 'invalid T_AXFER_VAR payload' }; memo.set(key, r); return r; }
      const outIdx = axferVarOutputIndexForVout(vout);
      if (outIdx === null) { const r = { ok: false, reason: `vout ${vout} is not a tacit output of this tx`, notTacit: true }; memo.set(key, r); return r; }
      // Only vout 0 and vout 2 are tacit for this opcode (see axferVarOutputIndexForVout) — memoAll's
      // sequential-vout assumption doesn't apply, so memoize those two positions directly instead.
      const markBothTacitVouts = (result) => {
        memo.set(`${txidHex}:0`, result.ok ? { ...result, commitment: dec.outputs[0].commitment } : result);
        memo.set(`${txidHex}:2`, result.ok ? { ...result, commitment: dec.outputs[1].commitment } : result);
        return memo.get(key);
      };
      if (tx.vin.length < 2) return markBothTacitVouts({ ok: false, reason: 'too few inputs for T_AXFER_VAR' });
      const ourAssetIdHex = bytesToHex(dec.assetId);
      const inp = tx.vin[1];
      const r = await _walk(env, inp.txid, inp.vout, network, memo, depth + 1, maxDepth);
      if (!r.ok) return markBothTacitVouts({ ok: false, reason: `input ${inp.txid}:${inp.vout}: ${r.reason}` });
      if (r.assetIdHex !== ourAssetIdHex) {
        return markBothTacitVouts({ ok: false, reason: `input ${inp.txid}:${inp.vout} is a different asset` });
      }
      let Cpts;
      try { Cpts = dec.outputs.map((o) => toPoint(o.commitment)); }
      catch { return markBothTacitVouts({ ok: false, reason: 'bad output commitment' }); }
      const rpOk = isBpp ? bppRangeVerify(Cpts, dec.rangeproof) : bpRangeAggVerify(Cpts, dec.rangeproof);
      if (!rpOk) return markBothTacitVouts({ ok: false, reason: 'output rangeproof failed' });
      let EPrime = ZERO;
      try {
        for (const o of dec.outputs) EPrime = EPrime.add(toPoint(o.commitment));
        EPrime = EPrime.add(toPoint(r.commitment).negate());
      } catch { return markBothTacitVouts({ ok: false, reason: 'commitment arithmetic failed' }); }
      if (EPrime.equals(ZERO)) return markBothTacitVouts({ ok: false, reason: 'zero kernel excess' });
      const exBytes = EPrime.toRawBytes(true).slice(1);
      const inputOutpoints = [{ txid: inp.txid, vout: inp.vout }];
      const outputCommitments = dec.outputs.map((o) => o.commitment);
      const msg = kernelMsg(dec.assetId, inputOutpoints, outputCommitments, 0n);
      if (!verifySchnorr(dec.kernelSig, msg, exBytes)) {
        return markBothTacitVouts({ ok: false, reason: 'kernel signature invalid' });
      }
      return markBothTacitVouts({ ok: true, assetIdHex: ourAssetIdHex });
    }

    const r = { ok: false, reason: `opcode 0x${envelope.opcode.toString(16)} is not covered by ancestry verification yet` };
    memo.set(key, r);
    return r;
  }

  return { verifyTacAncestry };
}
